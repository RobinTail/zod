import * as checks from "./checks.js";
import * as core from "./core.js";
import { Doc } from "./doc.js";
import type * as errors from "./errors.js";
import * as regexes from "./regexes.js";
import type { StandardSchemaV1 } from "./standard-schema.js";
import * as util from "./util.js";

/////////////////////////////   PARSE   //////////////////////////////

export interface ParseContext {
  /** Customize error messages. */
  readonly error?: errors.$ZodErrorMap<never>;
  /** Include the `input` field in issue objects. Default `false`. */
  readonly reportInput?: boolean;
  /** Skip eval-based fast path. Default `false`. */
  readonly noPrecompilation?: boolean;
  /** Abort validation after the first error. Default `false`. */
  // readonly abortEarly?: boolean;
}

/** @internal */
export interface ParseContextInternal extends ParseContext {
  readonly async?: boolean | undefined;
}

export interface ParsePayload<T = unknown> {
  value: T;
  issues: errors.$ZodRawIssue[];
}

export type CheckFn<T> = (input: ParsePayload<T>) => util.MaybeAsync<void>;

/////////////////////////////   SCHEMAS   //////////////////////////////

export interface $ZodTypeDef {
  type:
    | "string"
    | "number"
    | "int"
    | "boolean"
    | "bigint"
    | "symbol"
    | "null"
    | "undefined"
    | "void" // merge with undefined?
    | "never"
    | "any"
    | "unknown"
    | "date"
    | "object"
    | "interface"
    | "record"
    | "file"
    | "array"
    | "tuple"
    | "union"
    | "intersection"
    | "map"
    | "set"
    | "enum"
    | "literal"
    | "nullable"
    | "optional"
    | "nonoptional"
    | "success"
    | "transform"
    | "default"
    | "catch"
    | "nan"
    | "pipe"
    | "readonly"
    | "template_literal"
    | "promise"
    | "lazy"
    | "custom";
  error?: errors.$ZodErrorMap<never> | undefined;
  checks?: checks.$ZodCheck<never>[];
}

export interface $ZodTypeInternals<out O = unknown, out I = unknown> extends $ZodType<O, I> {
  /** Schema internals. */
  def: $ZodTypeDef;

  /** Randomly generated ID for this schema. */
  id: string;

  /** The inferred output typre */
  output: O;

  /** The inferred input type */
  input: I;

  /** List of deferred initializers. */
  deferred: util.AnyFunc[] | undefined;

  /** Parses input and runs all checks (refinements). */
  run(payload: ParsePayload<any>, ctx: ParseContextInternal): util.MaybeAsync<ParsePayload>;

  /** Parses input, doesn't run checks. */
  parse(payload: ParsePayload<any>, ctx: ParseContextInternal): util.MaybeAsync<ParsePayload>;

  /** Stores identifiers for the set of traits implemented by this schema. */
  traits: Set<string>;

  /** Indicates that a schema output type should be considered optional inside objects.  */
  qout: "true" | undefined;

  /** Indicates that a schema input type should be considered optional inside objects. */
  qin: "true" | undefined;

  /** A set of literal discriminators used for the fast path in discriminated unions. */
  disc: util.DiscriminatorMap | undefined;

  /** The set of literal values that will pass validation. Must be an exhaustive set. Used to determine optionality in z.record().
   *
   * Defined on: enum, const, literal, null, undefined
   * Passthrough: optional, nullable, branded, default, catch, pipe
   * Todo: unions?
   */
  values: util.PrimitiveSet | undefined;

  /** This flag indicates that a schema validation can be represented with a regular expression. Used to determine allowable schemas in z.templateLiteral(). */
  pattern: RegExp | undefined;

  /** The constructor function of this schema. */
  constr: new (
    def: any
  ) => any;

  /** A catchall object for computed metadata related to this schema. Commonly modified by checks using `onattach`. */
  computed: Record<string, any>;

  /** The set of issues this schema might throw during type checking. */
  isst: errors.$ZodIssueBase;

  /** An optional method used to override `toJSONSchema` logic. */
  toJSONSchema?: () => object;
}

export interface $ZodType<out O = unknown, out I = unknown> {
  _zod: $ZodTypeInternals<O, I>;
  "~standard": StandardSchemaV1.Props<this["_zod"]["input"], this["_zod"]["output"]>;
}

export const $ZodType: core.$constructor<$ZodType> = /*@__PURE__*/ core.$constructor("$ZodType", (inst, def) => {
  inst ??= {} as any;
  inst._zod.id = def.type + "_" + util.randomString(10);
  inst._zod.def = def; // set _def property
  inst._zod.computed = inst._zod.computed || {}; // initialize _computed object

  const checks = [...(inst._zod.def.checks ?? [])];
  def.type;

  // if inst is itself a checks.$ZodCheck, run it as a check
  if (inst._zod.traits.has("$ZodCheck")) {
    checks.unshift(inst as any);
  }
  //

  for (const ch of checks) {
    ch._zod.onattach?.(inst);
  }

  if (checks.length === 0) {
    // deferred initializer
    // inst._zod.parse is not yet defined
    inst._zod.deferred ??= [];
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (
      payload: ParsePayload,
      checks: checks.$ZodCheck<never>[],
      ctx?: ParseContextInternal | undefined
    ): util.MaybeAsync<ParsePayload> => {
      let isAborted = util.aborted(payload);
      let asyncResult!: Promise<unknown> | undefined;
      for (const ch of checks) {
        if (ch._zod.when) {
          const shouldRun = ch._zod.when(payload);

          if (!shouldRun) continue;
        } else {
          if (isAborted) {
            continue;
          }
        }

        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload as any) as any as ParsePayload;
        if (_ instanceof Promise && ctx?.async === false) {
          throw new core.$ZodAsyncError();
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = asyncResult ?? Promise.resolve();
          asyncResult.then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen) return;
            if (!isAborted) isAborted = util.aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen) continue;
          if (!isAborted) isAborted = util.aborted(payload, currLen);
        }
      }

      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };

    inst._zod.run = (payload, ctx) => {
      const result = inst._zod.parse(payload, ctx);

      if (result instanceof Promise) {
        if (ctx.async === false) throw new core.$ZodAsyncError();
        return result.then((result) => runChecks(result, checks, ctx));
      }

      return runChecks(result, checks, ctx);
    };
  }

  util.defineLazy(inst, "~standard", () => ({
    validate: (value: unknown) => {
      const result = inst._zod.run({ value, issues: [] }, {});
      if (result instanceof Promise) {
        return result.then(({ issues, value }) => {
          if (issues.length === 0) return { value } as any;
          return { issues };
        });
      }
      if (result.issues.length === 0) return { value: result.value } as any;
      return { issues: result.issues };
    },
    vendor: "zod",
    version: 1 as const,
  }));
});

export { clone } from "./util.js";

//////////////////////////////////////////
//////////////////////////////////////////
//////////                      //////////
//////////      $ZodString      //////////
//////////                      //////////
//////////////////////////////////////////
//////////////////////////////////////////
export interface $ZodStringDef extends $ZodTypeDef {
  type: "string";
  coerce?: boolean;
  checks?: checks.$ZodCheck<string>[];
}

export interface $ZodStringInternals<Input> extends $ZodTypeInternals<string, Input> {
  def: $ZodStringDef;
  /** @deprecated Internal API, use with caution (not deprecated) */
  pattern: RegExp;

  /** @deprecated Internal API, use with caution (not deprecated) */
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodString<Input = unknown> extends $ZodType {
  _zod: $ZodStringInternals<Input>;
}

export const $ZodString: core.$constructor<$ZodString> = /*@__PURE__*/ core.$constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = inst?._zod.computed?.pattern ?? regexes.string(inst._zod.computed);
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_) {}

    if (typeof payload.value === "string") return payload;

    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst,
    });
    return payload;
  };
});

//////////////////////////////   ZodStringFormat   //////////////////////////////

export interface $ZodStringFormatDef<Format extends checks.$ZodStringFormats = checks.$ZodStringFormats>
  extends $ZodStringDef,
    checks.$ZodCheckStringFormatDef<Format> {}

export interface $ZodStringFormatInternals<Format extends checks.$ZodStringFormats = checks.$ZodStringFormats>
  extends $ZodStringInternals<string>,
    checks.$ZodCheckStringFormatInternals {
  def: $ZodStringFormatDef<Format>;
}
export interface $ZodStringFormat<Format extends checks.$ZodStringFormats = checks.$ZodStringFormats> extends $ZodType {
  _zod: $ZodStringFormatInternals<Format>;
}

export const $ZodStringFormat: core.$constructor<$ZodStringFormat> = /*@__PURE__*/ core.$constructor(
  "$ZodStringFormat",
  (inst, def): void => {
    // check initialization must come first
    checks.$ZodCheckStringFormat.init(inst, def);
    $ZodString.init(inst, def);
  }
);

//////////////////////////////   ZodGUID   //////////////////////////////
export interface $ZodGUIDDef extends $ZodStringFormatDef<"guid"> {}
export interface $ZodGUIDInternals extends $ZodStringFormatInternals<"guid"> {}

export interface $ZodGUID extends $ZodType {
  _zod: $ZodGUIDInternals;
}

export const $ZodGUID: core.$constructor<$ZodGUID> = /*@__PURE__*/ core.$constructor("$ZodGUID", (inst, def): void => {
  def.pattern ??= regexes.guid;
  $ZodStringFormat.init(inst, def);
});

//////////////////////////////   ZodUUID   //////////////////////////////

export interface $ZodUUIDDef extends $ZodStringFormatDef<"uuid"> {
  version?: "v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v7" | "v8";
}

export interface $ZodUUIDInternals extends $ZodStringFormatInternals<"uuid"> {
  def: $ZodUUIDDef;
}

export interface $ZodUUID extends $ZodType {
  _zod: $ZodUUIDInternals;
}

export const $ZodUUID: core.$constructor<$ZodUUID> = /*@__PURE__*/ core.$constructor("$ZodUUID", (inst, def): void => {
  if (def.version) {
    const versionMap: Record<string, number> = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8,
    };
    const v = versionMap[def.version];
    if (v === undefined) throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ??= regexes.uuid(v);
  } else def.pattern ??= regexes.uuid();
  $ZodStringFormat.init(inst, def);
});

//////////////////////////////   ZodEmail   //////////////////////////////

export interface $ZodEmailDef extends $ZodStringFormatDef<"email"> {}
export interface $ZodEmailInternals extends $ZodStringFormatInternals<"email"> {}
export interface $ZodEmail extends $ZodType {
  _zod: $ZodEmailInternals;
}

export const $ZodEmail: core.$constructor<$ZodEmail> = /*@__PURE__*/ core.$constructor(
  "$ZodEmail",
  (inst, def): void => {
    def.pattern ??= regexes.email;
    $ZodStringFormat.init(inst, def);
  }
);

//////////////////////////////   ZodURL   //////////////////////////////

export interface $ZodURLDef extends $ZodStringFormatDef<"url"> {}
export interface $ZodURLInternals extends $ZodStringFormatInternals<"url"> {}

export interface $ZodURL extends $ZodType {
  _zod: $ZodURLInternals;
}

export const $ZodURL: core.$constructor<$ZodURL> = /*@__PURE__*/ core.$constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const url = new URL(payload.value);
      regexes.hostname.lastIndex = 0;
      if (!regexes.hostname.test(url.hostname)) throw new Error();
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
      });
    }
  };
});

//////////////////////////////   ZodEmoji   //////////////////////////////

export interface $ZodEmojiDef extends $ZodStringFormatDef<"emoji"> {}
export interface $ZodEmojiInternals extends $ZodStringFormatInternals<"emoji"> {}

export interface $ZodEmoji extends $ZodType {
  _zod: $ZodEmojiInternals;
}

export const $ZodEmoji: core.$constructor<$ZodEmoji> = /*@__PURE__*/ core.$constructor(
  "$ZodEmoji",
  (inst, def): void => {
    def.pattern ??= regexes.emoji();
    $ZodStringFormat.init(inst, def);
  }
);

//////////////////////////////   ZodNanoID   //////////////////////////////

export interface $ZodNanoIDDef extends $ZodStringFormatDef<"nanoid"> {}
export interface $ZodNanoIDInternals extends $ZodStringFormatInternals<"nanoid"> {}

export interface $ZodNanoID extends $ZodType {
  _zod: $ZodNanoIDInternals;
}

export const $ZodNanoID: core.$constructor<$ZodNanoID> = /*@__PURE__*/ core.$constructor(
  "$ZodNanoID",
  (inst, def): void => {
    def.pattern ??= regexes.nanoid;
    $ZodStringFormat.init(inst, def);
  }
);

//////////////////////////////   ZodCUID   //////////////////////////////

export interface $ZodCUIDDef extends $ZodStringFormatDef<"cuid"> {}
export interface $ZodCUIDInternals extends $ZodStringFormatInternals<"cuid"> {}

export interface $ZodCUID extends $ZodType {
  _zod: $ZodCUIDInternals;
}

export const $ZodCUID: core.$constructor<$ZodCUID> = /*@__PURE__*/ core.$constructor("$ZodCUID", (inst, def): void => {
  def.pattern ??= regexes.cuid;
  $ZodStringFormat.init(inst, def);
});

//////////////////////////////   ZodCUID2   //////////////////////////////

export interface $ZodCUID2Def extends $ZodStringFormatDef<"cuid2"> {}
export interface $ZodCUID2Internals extends $ZodStringFormatInternals<"cuid2"> {}

export interface $ZodCUID2 extends $ZodType {
  _zod: $ZodCUID2Internals;
}

export const $ZodCUID2: core.$constructor<$ZodCUID2> = /*@__PURE__*/ core.$constructor(
  "$ZodCUID2",
  (inst, def): void => {
    def.pattern ??= regexes.cuid2;
    $ZodStringFormat.init(inst, def);
  }
);

//////////////////////////////   ZodULID   //////////////////////////////

export interface $ZodULIDDef extends $ZodStringFormatDef<"ulid"> {}
export interface $ZodULIDInternals extends $ZodStringFormatInternals<"ulid"> {}

export interface $ZodULID extends $ZodType {
  _zod: $ZodULIDInternals;
}

export const $ZodULID: core.$constructor<$ZodULID> = /*@__PURE__*/ core.$constructor("$ZodULID", (inst, def): void => {
  def.pattern ??= regexes.ulid;
  $ZodStringFormat.init(inst, def);
});

//////////////////////////////   ZodXID   //////////////////////////////

export interface $ZodXIDDef extends $ZodStringFormatDef<"xid"> {}
export interface $ZodXIDInternals extends $ZodStringFormatInternals<"xid"> {}

export interface $ZodXID extends $ZodType {
  _zod: $ZodXIDInternals;
}

export const $ZodXID: core.$constructor<$ZodXID> = /*@__PURE__*/ core.$constructor("$ZodXID", (inst, def): void => {
  def.pattern ??= regexes.xid;
  $ZodStringFormat.init(inst, def);
});

//////////////////////////////   ZodKSUID   //////////////////////////////

export interface $ZodKSUIDDef extends $ZodStringFormatDef<"ksuid"> {}
export interface $ZodKSUIDInternals extends $ZodStringFormatInternals<"ksuid"> {}

export interface $ZodKSUID extends $ZodType {
  _zod: $ZodKSUIDInternals;
}

export const $ZodKSUID: core.$constructor<$ZodKSUID> = /*@__PURE__*/ core.$constructor(
  "$ZodKSUID",
  (inst, def): void => {
    def.pattern ??= regexes.ksuid;
    $ZodStringFormat.init(inst, def);
  }
);

//////////////////////////////   ZodISODateTime   //////////////////////////////

export interface $ZodISODateTimeDef extends $ZodStringFormatDef<"iso_datetime"> {
  precision: number | null;
  offset: boolean;
  local: boolean;
}

export interface $ZodISODateTimeInternals extends $ZodStringFormatInternals {
  def: $ZodISODateTimeDef;
}

export interface $ZodISODateTime extends $ZodType {
  _zod: $ZodISODateTimeInternals;
}

export const $ZodISODateTime: core.$constructor<$ZodISODateTime> = /*@__PURE__*/ core.$constructor(
  "$ZodISODateTime",
  (inst, def): void => {
    def.pattern ??= regexes.datetime(def);
    $ZodStringFormat.init(inst, def);
  }
);

//////////////////////////////   ZodISODate   //////////////////////////////

export interface $ZodISODateDef extends $ZodStringFormatDef<"iso_date"> {}
export interface $ZodISODateInternals extends $ZodStringFormatInternals<"iso_date"> {}

export interface $ZodISODate extends $ZodType {
  _zod: $ZodISODateInternals;
}

export const $ZodISODate: core.$constructor<$ZodISODate> = /*@__PURE__*/ core.$constructor(
  "$ZodISODate",
  (inst, def): void => {
    def.pattern ??= regexes.date;
    $ZodStringFormat.init(inst, def);
  }
);

//////////////////////////////   ZodISOTime   //////////////////////////////

export interface $ZodISOTimeDef extends $ZodStringFormatDef<"iso_time"> {
  precision?: number | null;
  // offset?: boolean;
  // local?: boolean;
}

export interface $ZodISOTimeInternals extends $ZodStringFormatInternals<"iso_time"> {
  def: $ZodISOTimeDef;
}

export interface $ZodISOTime extends $ZodType {
  _zod: $ZodISOTimeInternals;
}

export const $ZodISOTime: core.$constructor<$ZodISOTime> = /*@__PURE__*/ core.$constructor(
  "$ZodISOTime",
  (inst, def): void => {
    def.pattern ??= regexes.time(def);
    $ZodStringFormat.init(inst, def);
  }
);

//////////////////////////////   ZodISODuration   //////////////////////////////

export interface $ZodISODurationDef extends $ZodStringFormatDef<"iso_duration"> {}
export interface $ZodISODurationInternals extends $ZodStringFormatInternals<"iso_duration"> {}

export interface $ZodISODuration extends $ZodType {
  _zod: $ZodISODurationInternals;
}

export const $ZodISODuration: core.$constructor<$ZodISODuration> = /*@__PURE__*/ core.$constructor(
  "$ZodISODuration",
  (inst, def): void => {
    def.pattern ??= regexes.duration;
    $ZodStringFormat.init(inst, def);
  }
);

//////////////////////////////   ZodIPv4   //////////////////////////////

export interface $ZodIPv4Def extends $ZodStringFormatDef<"ipv4"> {
  version?: "v4";
}

export interface $ZodIPv4Internals extends $ZodStringFormatInternals<"ipv4"> {
  def: $ZodIPv4Def;
}

export interface $ZodIPv4 extends $ZodType {
  _zod: $ZodIPv4Internals;
}

export const $ZodIPv4: core.$constructor<$ZodIPv4> = /*@__PURE__*/ core.$constructor("$ZodIPv4", (inst, def): void => {
  def.pattern ??= regexes.ipv4;
  $ZodStringFormat.init(inst, def);
  const superAttach = inst._zod.onattach;
  inst._zod.onattach = (inst) => {
    superAttach?.(inst);
    inst._zod.computed.format = `ipv4`;
  };
});
//////////////////////////////   ZodIPv6   //////////////////////////////

export interface $ZodIPv6Def extends $ZodStringFormatDef<"ipv6"> {
  version?: "v6";
}

export interface $ZodIPv6Internals extends $ZodStringFormatInternals<"ipv6"> {
  def: $ZodIPv6Def;
}

export interface $ZodIPv6 extends $ZodType {
  _zod: $ZodIPv6Internals;
}

export const $ZodIPv6: core.$constructor<$ZodIPv6> = /*@__PURE__*/ core.$constructor("$ZodIPv6", (inst, def): void => {
  def.pattern ??= regexes.ipv6;
  $ZodStringFormat.init(inst, def);
  const superAttach = inst._zod.onattach;
  inst._zod.onattach = (inst) => {
    superAttach?.(inst);
    inst._zod.computed.format = `ipv6`;
  };

  inst._zod.check = (payload) => {
    try {
      new URL(`http://[${payload.value}]`);
      // return;
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
      });
    }
  };
});

//////////////////////////////   ZodIP   //////////////////////////////

// export interface $ZodIPDef extends $ZodStringFormatDef<"ip"> {
//   version?: "v4" | "v6";
// }

// export interface $ZodIPInternals extends $ZodStringFormatInternals<"ip"> {
//   def: $ZodIPDef;
// }

// export interface $ZodIP extends $ZodType {
//   _zod: $ZodIPInternals;
// }

// export const $ZodIP: core.$constructor<$ZodIP> = /*@__PURE__*/ core.$constructor("$ZodIP", (inst, def): void => {
//   if (def.version === "v4") def.pattern ??= regexes.ipv4;
//   else if (def.version === "v6") def.pattern ??= regexes.ipv6;
//   else def.pattern ??= regexes.ip;
//   $ZodStringFormat.init(inst, def);
//   const superAttach = inst._zod.onattach;
//   inst._zod.onattach = (inst) => {
//     superAttach?.(inst);
//     inst._zod.computed.format = `ip${def.version ?? ""}`;
//   };
// });

//////////////////////////////   ZodBase64   //////////////////////////////

export interface $ZodBase64Def extends $ZodStringFormatDef<"base64"> {}
export interface $ZodBase64Internals extends $ZodStringFormatInternals<"base64"> {}

export interface $ZodBase64 extends $ZodType {
  _zod: $ZodBase64Internals;
}

export const $ZodBase64: core.$constructor<$ZodBase64> = /*@__PURE__*/ core.$constructor(
  "$ZodBase64",
  (inst, def): void => {
    def.pattern ??= regexes.base64;
    $ZodStringFormat.init(inst, def);

    const superAttach = inst._zod.onattach;
    inst._zod.onattach = (inst) => {
      superAttach?.(inst);
      inst._zod.computed.contentEncoding = "base64";
    };
  }
);

//////////////////////////////   ZodJSONString   //////////////////////////////

// export interface $ZodJSONStringDef extends $ZodStringFormatDef<"json_string"> {}
// export Def $ZodJSONStringDef extends $ZodStringFormatInternals {
// export interface $ZodJSONStringInternals extends $ZodStringFormatInternals {
//   _def: $ZodJSONStringDef;
// }

// export const $ZodJSONString: core.$constructor<{_zod: $ZodJSONStringInternals}> = /*@__PURE__*/ core.$constructor(
//   "$ZodJSONString",
//   (inst, def): void => {
//     $ZodStringFormat.init(inst, def);
//     inst._zod.check = (payload) => {
//       try {
//         JSON.parse(payload.value);
//         return;
//       } catch {
//         payload.issues.push({
//           code: "invalid_format",
//           format: "json_string",
//           input: payload.value,
//           inst,
//         });
//       }
//     };
//   }
// );

//////////////////////////////   ZodE164   //////////////////////////////

export interface $ZodE164Def extends $ZodStringFormatDef<"e164"> {}
export interface $ZodE164Internals extends $ZodStringFormatInternals<"e164"> {}

export interface $ZodE164 extends $ZodType {
  _zod: $ZodE164Internals;
}

export const $ZodE164: core.$constructor<$ZodE164> = /*@__PURE__*/ core.$constructor("$ZodE164", (inst, def): void => {
  def.pattern ??= regexes.e164;
  $ZodStringFormat.init(inst, def);
});

//////////////////////////////   ZodJWT   //////////////////////////////

export function isValidJWT(token: string, algorithm: util.JWTAlgorithm | null = null): boolean {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3) return false;
    const [header] = tokensParts;
    const parsedHeader = JSON.parse(atob(header));
    if (!("typ" in parsedHeader) || parsedHeader.typ !== "JWT") return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
    return true;
  } catch {
    return false;
  }
}

export interface $ZodJWTDef extends $ZodStringFormatDef<"jwt"> {
  alg?: util.JWTAlgorithm | undefined;
}

export interface $ZodJWTInternals extends $ZodStringFormatInternals<"jwt"> {
  def: $ZodJWTDef;
}

export interface $ZodJWT extends $ZodType {
  _zod: $ZodJWTInternals;
}

export const $ZodJWT: core.$constructor<$ZodJWT> = /*@__PURE__*/ core.$constructor("$ZodJWT", (inst, def): void => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg)) return;

    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
    });
  };
});

/////////////////////////////////////////
/////////////////////////////////////////
//////////                     //////////
//////////      ZodNumber      //////////
//////////                     //////////
/////////////////////////////////////////
/////////////////////////////////////////

export interface $ZodNumberDef extends $ZodTypeDef {
  type: "number";
  coerce?: boolean;
  // checks: checks.$ZodCheck<number>[];
}

export interface $ZodNumberInternals<Input = unknown> extends $ZodTypeInternals<number, Input> {
  def: $ZodNumberDef;
  /** @deprecated Internal API, use with caution (not deprecated) */
  pattern: RegExp;
  /** @deprecated Internal API, use with caution (not deprecated) */
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodNumber<Input = unknown> extends $ZodType {
  _zod: $ZodNumberInternals<Input>;
}

export const $ZodNumber: core.$constructor<$ZodNumber> = /*@__PURE__*/ core.$constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = inst._zod.computed.pattern ?? regexes.number;

  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }

    const received =
      typeof input === "number"
        ? Number.isNaN(input)
          ? "NaN"
          : !Number.isFinite(input)
            ? "Infinity"
            : undefined
        : undefined;

    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...(received ? { received } : {}),
    });
    return payload;
  };
});

///////////////////////////////////////////////
//////////      ZodNumberFormat      //////////
///////////////////////////////////////////////
export interface $ZodNumberFormatDef extends $ZodNumberDef, checks.$ZodCheckNumberFormatDef {}

export interface $ZodNumberFormatInternals extends $ZodNumberInternals<number>, checks.$ZodCheckNumberFormatInternals {
  def: $ZodNumberFormatDef;
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodNumberFormat extends $ZodType {
  _zod: $ZodNumberFormatInternals;
}

export const $ZodNumberFormat: core.$constructor<$ZodNumberFormat> = /*@__PURE__*/ core.$constructor(
  "$ZodNumber",
  (inst, def) => {
    checks.$ZodCheckNumberFormat.init(inst, def);
    $ZodNumber.init(inst, def); // no format checksp
  }
);

///////////////////////////////////////////
///////////////////////////////////////////
//////////                      ///////////
//////////      $ZodBoolean      //////////
//////////                      ///////////
///////////////////////////////////////////
///////////////////////////////////////////

export interface $ZodBooleanDef extends $ZodTypeDef {
  type: "boolean";
  coerce?: boolean;
  checks?: checks.$ZodCheck<boolean>[];
}

export interface $ZodBooleanInternals<T = unknown> extends $ZodTypeInternals<boolean, T> {
  pattern: RegExp;
  def: $ZodBooleanDef;
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodBoolean<T = unknown> extends $ZodType {
  _zod: $ZodBooleanInternals<T>;
}

export const $ZodBoolean: core.$constructor<$ZodBoolean> = /*@__PURE__*/ core.$constructor(
  "$ZodBoolean",
  (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.pattern = regexes.boolean;

    inst._zod.parse = (payload, _ctx) => {
      if (def.coerce)
        try {
          payload.value = Boolean(payload.value);
        } catch (_) {}
      const input = payload.value;
      if (typeof input === "boolean") return payload;
      payload.issues.push({
        expected: "boolean",
        code: "invalid_type",
        input,
        inst,
      });
      return payload;
    };
  }
);

//////////////////////////////////////////
//////////////////////////////////////////
//////////                      //////////
//////////      $ZodBigInt      //////////
//////////                      //////////
//////////////////////////////////////////
//////////////////////////////////////////

export interface $ZodBigIntDef extends $ZodTypeDef {
  type: "bigint";
  coerce?: boolean;
  // checks: checks.$ZodCheck<bigint>[];
}

export interface $ZodBigIntInternals<T = unknown> extends $ZodTypeInternals<bigint, T> {
  pattern: RegExp;
  /** @internal Internal API, use with caution */
  def: $ZodBigIntDef;
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodBigInt<T = unknown> extends $ZodType {
  _zod: $ZodBigIntInternals<T>;
}

export const $ZodBigInt: core.$constructor<$ZodBigInt> = /*@__PURE__*/ core.$constructor("$ZodBigInt", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = regexes.bigint;

  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = BigInt(payload.value as any);
      } catch (_) {}
    const { value: input } = payload;
    if (typeof input === "bigint") return payload;
    payload.issues.push({
      expected: "bigint",
      code: "invalid_type",
      input,
      inst,
    });
    return payload;
  };
});

///////////////////////////////////////////////
//////////      ZodBigIntFormat      //////////
///////////////////////////////////////////////
export interface $ZodBigIntFormatDef extends $ZodBigIntDef, checks.$ZodCheckBigIntFormatDef {
  check: "bigint_format";
}

export interface $ZodBigIntFormatInternals extends $ZodBigIntInternals<bigint>, checks.$ZodCheckBigIntFormatInternals {
  def: $ZodBigIntFormatDef;
}

export interface $ZodBigIntFormat extends $ZodType {
  _zod: $ZodBigIntFormatInternals;
}

export const $ZodBigIntFormat: core.$constructor<$ZodBigIntFormat> = /*@__PURE__*/ core.$constructor(
  "$ZodBigInt",
  (inst, def) => {
    checks.$ZodCheckBigIntFormat.init(inst, def);
    $ZodBigInt.init(inst, def); // no format checks
  }
);

////////////////////////////////////////////
////////////////////////////////////////////
//////////                        //////////
//////////       $ZodSymbol       //////////
//////////                        //////////
////////////////////////////////////////////
////////////////////////////////////////////
export interface $ZodSymbolDef extends $ZodTypeDef {
  type: "symbol";
}

export interface $ZodSymbolInternals extends $ZodTypeInternals<symbol, symbol> {
  def: $ZodSymbolDef;
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodSymbol extends $ZodType {
  _zod: $ZodSymbolInternals;
}

export const $ZodSymbol: core.$constructor<$ZodSymbol> = /*@__PURE__*/ core.$constructor("$ZodSymbol", (inst, def) => {
  $ZodType.init(inst, def);

  inst._zod.parse = (payload, _ctx) => {
    const { value: input } = payload;
    if (typeof input === "symbol") return payload;
    payload.issues.push({
      expected: "symbol",
      code: "invalid_type",
      input,
      inst,
    });
    return payload;
  };
});

////////////////////////////////////////////
////////////////////////////////////////////
//////////                        //////////
//////////      $ZodUndefined     //////////
//////////                        //////////
////////////////////////////////////////////
////////////////////////////////////////////
export interface $ZodUndefinedDef extends $ZodTypeDef {
  type: "undefined";
}

export interface $ZodUndefinedInternals extends $ZodTypeInternals<undefined, undefined> {
  pattern: RegExp;
  def: $ZodUndefinedDef;
  values: util.PrimitiveSet;
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodUndefined extends $ZodType {
  _zod: $ZodUndefinedInternals;
}

export const $ZodUndefined: core.$constructor<$ZodUndefined> = /*@__PURE__*/ core.$constructor(
  "$ZodUndefined",
  (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.pattern = regexes.undefined;
    inst._zod.values = new Set([undefined]);

    inst._zod.parse = (payload, _ctx) => {
      const { value: input } = payload;
      if (typeof input === "undefined") return payload;
      payload.issues.push({
        expected: "undefined",
        code: "invalid_type",
        input,
        inst,
      });
      return payload;
    };
  }
);

///////////////////////////////////////
///////////////////////////////////////
//////////                   //////////
//////////      $ZodNull      /////////
//////////                   //////////
///////////////////////////////////////
///////////////////////////////////////

export interface $ZodNullDef extends $ZodTypeDef {
  type: "null";
}

export interface $ZodNullInternals extends $ZodTypeInternals<null, null> {
  pattern: RegExp;
  def: $ZodNullDef;
  values: util.PrimitiveSet;
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodNull extends $ZodType {
  _zod: $ZodNullInternals;
}

export const $ZodNull: core.$constructor<$ZodNull> = /*@__PURE__*/ core.$constructor("$ZodNull", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = regexes.null;
  inst._zod.values = new Set([null]);

  inst._zod.parse = (payload, _ctx) => {
    const { value: input } = payload;
    if (input === null) return payload;
    payload.issues.push({
      expected: "null",
      code: "invalid_type",
      input,
      inst,
    });
    return payload;
  };
});

//////////////////////////////////////
//////////////////////////////////////
//////////                  //////////
//////////      $ZodAny     //////////
//////////                  //////////
//////////////////////////////////////
//////////////////////////////////////

export interface $ZodAnyDef extends $ZodTypeDef {
  type: "any";
}

export interface $ZodAnyInternals extends $ZodTypeInternals<any, any> {
  def: $ZodAnyDef;
  isst: never;
}

export interface $ZodAny extends $ZodType {
  _zod: $ZodAnyInternals;
}

export const $ZodAny: core.$constructor<$ZodAny> = /*@__PURE__*/ core.$constructor("$ZodAny", (inst, def) => {
  $ZodType.init(inst, def);

  inst._zod.parse = (payload) => payload;
});

//////////////////////////////////////////
//////////////////////////////////////////
//////////                      //////////
//////////      $ZodUnknown     //////////
//////////                      //////////
//////////////////////////////////////////
//////////////////////////////////////////

export interface $ZodUnknownDef extends $ZodTypeDef {
  type: "unknown";
}

export interface $ZodUnknownInternals extends $ZodTypeInternals<unknown, unknown> {
  def: $ZodUnknownDef;
  isst: never;
}

export interface $ZodUnknown extends $ZodType {
  _zod: $ZodUnknownInternals;
}

export const $ZodUnknown: core.$constructor<$ZodUnknown> = /*@__PURE__*/ core.$constructor(
  "$ZodUnknown",
  (inst, def) => {
    $ZodType.init(inst, def);

    inst._zod.parse = (payload) => payload;
  }
);

/////////////////////////////////////////
/////////////////////////////////////////
//////////                     //////////
//////////      $ZodNever      //////////
//////////                     //////////
/////////////////////////////////////////
/////////////////////////////////////////

export interface $ZodNeverDef extends $ZodTypeDef {
  type: "never";
}

export interface $ZodNeverInternals extends $ZodTypeInternals<never, never> {
  def: $ZodNeverDef;
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodNever extends $ZodType {
  _zod: $ZodNeverInternals;
}

export const $ZodNever: core.$constructor<$ZodNever> = /*@__PURE__*/ core.$constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);

  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst,
    });
    return payload;
  };
});

////////////////////////////////////////
////////////////////////////////////////
//////////                    //////////
//////////      $ZodVoid      //////////
//////////                    //////////
////////////////////////////////////////
////////////////////////////////////////

export interface $ZodVoidDef extends $ZodTypeDef {
  type: "void";
}

export interface $ZodVoidInternals extends $ZodTypeInternals<void, void> {
  def: $ZodVoidDef;
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodVoid extends $ZodType {
  _zod: $ZodVoidInternals;
}

export const $ZodVoid: core.$constructor<$ZodVoid> = /*@__PURE__*/ core.$constructor("$ZodVoid", (inst, def) => {
  $ZodType.init(inst, def);

  inst._zod.parse = (payload, _ctx) => {
    const { value: input } = payload;
    if (typeof input === "undefined") return payload;
    payload.issues.push({
      expected: "void",
      code: "invalid_type",
      input,
      inst,
    });
    return payload;
  };
});

///////////////////////////////////////
///////////////////////////////////////
//////////                     ////////
//////////      $ZodDate        ////////
//////////                     ////////
///////////////////////////////////////
///////////////////////////////////////
export interface $ZodDateDef extends $ZodTypeDef {
  type: "date";
  coerce?: boolean;
}

export interface $ZodDateInternals<T = unknown> extends $ZodTypeInternals<Date, T> {
  def: $ZodDateDef;
  isst: errors.$ZodIssueInvalidType; // | errors.$ZodIssueInvalidDate;
}

export interface $ZodDate<T = unknown> extends $ZodType {
  _zod: $ZodDateInternals<T>;
}

export const $ZodDate: core.$constructor<$ZodDate> = /*@__PURE__*/ core.$constructor("$ZodDate", (inst, def) => {
  $ZodType.init(inst, def);

  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce) {
      try {
        payload.value = new Date(payload.value as string | number | Date);
      } catch (_err: any) {}
    }
    const input = payload.value;

    const isDate = input instanceof Date;
    const isValidDate = isDate && !Number.isNaN(input.getTime());
    if (isValidDate) return payload;
    payload.issues.push({
      expected: "date",
      code: "invalid_type",
      input,
      ...(isDate ? { received: "Invalid Date" } : {}),
      inst,
    });

    return payload;
  };
});

/////////////////////////////////////////
/////////////////////////////////////////
//////////                     //////////
//////////      $ZodArray      //////////
//////////                     //////////
/////////////////////////////////////////
/////////////////////////////////////////

export interface $ZodArrayDef<T extends $ZodType = $ZodType> extends $ZodTypeDef {
  type: "array";
  element: T;
}

export interface $ZodArrayInternals<T extends $ZodType = $ZodType>
  extends $ZodTypeInternals<T["_zod"]["output"][], T["_zod"]["input"][]> {
  def: $ZodArrayDef<T>;
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodArray<T extends $ZodType = $ZodType> extends $ZodType {
  _zod: $ZodArrayInternals<T>;
}

function handleArrayResult(result: ParsePayload<any>, final: ParsePayload<any[]>, index: number) {
  if (result.issues.length) {
    final.issues.push(...util.prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}

export const $ZodArray: core.$constructor<$ZodArray> = /*@__PURE__*/ core.$constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);

  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;

    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst,
      });
      return payload;
    }

    payload.value = Array(input.length);
    const proms: Promise<any>[] = [];
    for (let i = 0; i < input.length; i++) {
      const item = input[i];

      const result = def.element._zod.run(
        {
          value: item,
          issues: [],
        },
        ctx
      );

      if (result instanceof Promise) {
        proms.push(result.then((result) => handleArrayResult(result, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
      }
    }

    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }

    return payload; //handleArrayResultsAsync(parseResults, final);
  };
});

//////////////////////////////////////////
//////////////////////////////////////////
//////////                      //////////
//////////      $ZodObjectLike      //////////
//////////                      //////////
//////////////////////////////////////////
//////////////////////////////////////////

export type $ZodShape = Readonly<{ [k: string]: $ZodType }>;

export interface $ZodObjectLikeDef<out Shape extends $ZodShape = $ZodShape> extends $ZodTypeDef {
  type: "object" | "interface";
  shape: Shape;
  optional: string[];
  catchall?: $ZodType | undefined;
}

export interface $ZodObjectLikeInternals<out O = object, out I = object> extends $ZodTypeInternals<O, I> {
  def: $ZodObjectLikeDef;
  shape: $ZodShape;
  extra: Record<string, unknown>;
  optional: string;
  defaulted: string;
  isst: errors.$ZodIssueInvalidType | errors.$ZodIssueUnrecognizedKeys;
  disc: util.DiscriminatorMap;
}

function handleObjectResult(result: ParsePayload, final: ParsePayload, key: PropertyKey) {
  // if(isOptional)
  if (result.issues.length) {
    final.issues.push(...util.prefixIssues(key, result.issues));
  } else {
    (final.value as any)[key] = result.value;
  }
}

function handleOptionalObjectResult(result: ParsePayload, final: ParsePayload, key: PropertyKey, input: any) {
  if (result.issues.length) {
    if (input[key] === undefined) {
      if (key in input) {
        (final.value as any)[key] = undefined;
      }
    } else {
      final.issues.push(...util.prefixIssues(key, result.issues));
    }
  } else if (result.value === undefined) {
    if (key in input) (final.value as any)[key] = undefined;
  } else {
    (final.value as any)[key] = result.value;
  }
}

export interface $ZodObjectLike<O = object, I = object> extends $ZodType {
  _zod: $ZodObjectLikeInternals<O, I>;
}

export const $ZodObjectLike: core.$constructor<$ZodObjectLike> = /*@__PURE__*/ core.$constructor(
  "$ZodObjectLike",
  (inst, def) => {
    $ZodType.init(inst, def);
    util.defineLazy(inst._zod, "shape", () => def.shape);

    const _normalized = util.cached(() => {
      const keys = Object.keys(def.shape);
      return {
        shape: def.shape,
        keys,
        keySet: new Set(keys),
        numKeys: keys.length,
        optionalKeys: new Set(def.optional),
      };
    });

    util.defineLazy(inst._zod, "disc", () => {
      const shape = def.shape;
      const discMap: util.DiscriminatorMap = new Map();
      let hasDisc = false;
      for (const key in shape) {
        const field = shape[key]._zod;
        if (field.values || field.disc) {
          hasDisc = true;
          const o: util.DiscriminatorMapElement = {
            values: new Set(field.values ?? []),
            maps: field.disc ? [field.disc] : [],
          };
          discMap.set(key, o);
        }
      }
      if (!hasDisc) return undefined as any;
      return discMap;
    });

    const generateFastpass = (shape: any) => {
      const doc = new Doc(["shape", "payload", "ctx"]);
      const { keys, optionalKeys } = _normalized.value;
      const parseStr = (key: string) => {
        const k = util.esc(key);
        return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
      };

      // doc.write(`const shape = inst._zod.def.shape;`);
      doc.write(`const input = payload.value;`);

      const ids: any = {};
      for (const key of keys) {
        ids[key] = util.randomString(15);
      }
      for (const key of keys) {
        if (optionalKeys.has(key)) continue;
        const id = ids[key];
        doc.write(`const ${id} = ${parseStr(key)};`);
        doc.write(`
          if (${id}.issues.length) payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${util.esc(key)}, ...iss.path] : [${util.esc(key)}]
          })));`);
      }

      // check for missing keys
      // for (const key of keys) {
      //   if (optionalKeys.has(key)) continue;
      //   doc.write(`if(!(${util.esc(key)} in input)) {`);
      //   doc.indented(() => {
      //     doc.write(`payload.issues.push({`);
      //     doc.indented(() => {
      //       doc.write(`code: "invalid_type",`);
      //       doc.write(`path: [${util.esc(key)}],`);
      //       doc.write(`expected: "nonoptional",`);
      //       doc.write(`note: 'Missing required key: "${key}"',`);
      //       doc.write(`input,`);
      //       doc.write(`inst,`);
      //     });
      //     doc.write(`});`);
      //   });
      //   doc.write(`}`);
      // }

      // add required keys to result
      // doc.write(`return payload;`);
      // doc.write(`if(Object.keys(input).length === ${keys.length}) {
      //   payload.value = {...input};
      //   return payload;
      // }`);
      doc.write(`payload.value = {`);
      doc.indented(() => {
        for (const key of keys) {
          if (optionalKeys.has(key)) continue;
          const id = ids[key];
          doc.write(`  ${util.esc(key)}: ${id}.value,`);
          // doc.write(`payload.value[${util.esc(key)}] = ${id}.value;`);
        }
      });
      doc.write(`}`);

      // add in optionalKeys if defined

      // OLD: only run validation if they are define in input
      // for (const key of keys) {
      //   if (!optionalKeys.has(key)) continue;
      //   const id = ids[key];
      //   doc.write(`if (${util.esc(key)} in input) {`);
      //   doc.indented(() => {
      //     doc.write(`if(input[${util.esc(key)}] === undefined) {`);
      //     doc.indented(() => {
      //       doc.write(`payload.value[${util.esc(key)}] = undefined;`);
      //     });
      //     doc.write(`} else {`);
      //     doc.indented(() => {
      //       doc.write(`const ${id} = ${parseStr(key)};`);
      //       doc.write(`payload.value[${util.esc(key)}] = ${id}.value;`);
      //       doc.write(`
      //         if (${id}.issues.length) payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
      //           ...iss,
      //           path: iss.path ? [${util.esc(key)}, ...iss.path] : [${util.esc(key)}]
      //         })));`);
      //     });
      //     doc.write(`}`);
      //   });
      //   doc.write(`}`);
      // }

      // NEW: always run validation
      // this lets default values get applied to optionals
      for (const key of keys) {
        if (!optionalKeys.has(key)) continue;
        const id = ids[key];
        doc.write(`const ${id} = ${parseStr(key)};`);
        const k = util.esc(key);
        doc.write(`
        if (${id}.issues.length) {
          if (input[${k}] === undefined) {
            if (${k} in input) {
              payload.value[${k}] = undefined;
            }
          } else {
            payload.issues = payload.issues.concat(
              ${id}.issues.map((iss) => ({
                ...iss,
                path: iss.path ? [${k}, ...iss.path] : [${k}],
              }))
            );
          }
        } else if (${id}.value === undefined) {
          if (${k} in input) payload.value[${k}] = undefined;
        } else {
          payload.value[${k}] = ${id}.value;
        }  
        `);
      }

      // doc.write(`payload.value = final;`);
      doc.write(`return payload;`);
      // return doc.compile().bind(null, shape);
      const fn = doc.compile();
      return (payload: any, ctx: any) => fn(shape, payload, ctx);
      // return fn.bind(null, _inst._zod.def.shape);
    };

    let fastpass!: ReturnType<typeof generateFastpass>;
    const fastEnabled = util.allowsEval.value; // && !def.catchall;
    const isObject = util.isObject;
    const { catchall } = def;
    // const noCatchall = !def.catchall;

    inst._zod.parse = (payload, ctx) => {
      const input = payload.value;
      if (!isObject(input)) {
        payload.issues.push({
          expected: "object",
          code: "invalid_type",
          input,
          inst,
        });
        return payload;
      }

      const proms: Promise<any>[] = [];

      if (fastEnabled && ctx?.async === false && ctx.noPrecompilation !== true) {
        // always synchronous
        if (!fastpass) fastpass = generateFastpass(def.shape);
        payload = fastpass(payload, ctx);
      } else {
        payload.value = {};
        // const normalized = _normalized.value;
        const { keys, shape, optionalKeys } = _normalized.value;
        for (const key of keys) {
          const valueSchema = shape[key];

          // do not add omitted optional keys
          // if (!(key in input)) {
          //   if (optionalKeys.has(key)) continue;
          //   payload.issues.push({
          //     code: "invalid_type",
          //     path: [key],
          //     expected: "nonoptional",
          //     note: `Missing required key: "${key}"`,
          //     input,
          //     inst,
          //   });
          // }

          const r = valueSchema._zod.run({ value: input[key], issues: [] }, ctx);
          const isOptional = optionalKeys.has(key);
          // if (isOptional) {
          //   if (!(key in input)) {
          //     continue;
          //   }
          //   if (input[key] === undefined) {
          //     input[key] = undefined;
          //     continue;
          //   }
          // }

          // const r = valueSchema._zod.run({ value: input[key], issues: [] }, ctx);
          if (r instanceof Promise) {
            proms.push(
              r.then((r) =>
                isOptional ? handleOptionalObjectResult(r, payload, key, input) : handleObjectResult(r, payload, key)
              )
            );
          } else {
            if (isOptional) {
              handleOptionalObjectResult(r, payload, key, input);
            } else {
              handleObjectResult(r, payload, key);
            }
          }
        }
      }

      if (!catchall) {
        // return payload;
        return proms.length ? Promise.all(proms).then(() => payload) : payload;
      }
      const unrecognized: string[] = [];
      // iterate over input keys
      for (const key of Object.keys(input)) {
        if (_normalized.value.keySet.has(key)) continue;
        if (catchall._zod.def.type === "never") {
          unrecognized.push(key);
          continue;
        }
        const r = catchall._zod.run({ value: input[key], issues: [] }, ctx);

        if (r instanceof Promise) {
          proms.push(r.then((r) => handleObjectResult(r, payload, key)));
        } else {
          handleObjectResult(r, payload, key);
        }
      }

      if (unrecognized.length) {
        payload.issues.push({
          code: "unrecognized_keys",
          keys: unrecognized,
          input,
          inst,
        });
      }

      if (!proms.length) return payload;
      return Promise.all(proms).then(() => {
        return payload;
      });
    };
  }
);

///////////////////////////////////////////////////
/////////////      $ZodInterface      /////////////
///////////////////////////////////////////////////
// looser type is required for recursive inference
export type $ZodLooseShape = Record<string, any>;

export type $InferInterfaceOutput<
  T extends $ZodLooseShape,
  Params extends $ZodInterfaceNamedParams,
> = string extends keyof T
  ? object
  : {} extends T
    ? object
    : util.Flatten<
        {
          -readonly [k in Params["optional"]]?: T[k]["_zod"]["output"];
        } & {
          -readonly [k in Exclude<keyof T, Params["optional"]>]: T[k]["_zod"]["output"];
        } & Params["extra"]
      >;

export type $InferInterfaceInput<
  T extends $ZodLooseShape,
  Params extends $ZodInterfaceNamedParams,
> = string extends keyof T
  ? Record<string, unknown>
  : $ZodInterfaceNamedParams extends Params
    ? Record<string, unknown>
    : util.Flatten<
        {
          -readonly [k in Params["optional"] | Params["defaulted"]]?: T[k]["_zod"]["input"];
        } & {
          -readonly [k in Exclude<keyof T, Params["optional"] | Params["defaulted"]>]: T[k]["_zod"]["input"];
        } & Params["extra"]
      >;

export interface $ZodInterfaceDef<out Shape extends $ZodLooseShape = $ZodLooseShape> extends $ZodObjectLikeDef<Shape> {
  type: "interface";
}

export interface $ZodInterfaceNamedParams {
  optional: string;
  defaulted: string;
  extra: Record<string, unknown>;
}

export interface $ZodInterfaceInternals<
  Shape extends Readonly<$ZodLooseShape> = Readonly<$ZodLooseShape>,
  Params extends $ZodInterfaceNamedParams = $ZodInterfaceNamedParams,
> extends $ZodObjectLikeInternals<$InferInterfaceOutput<Shape, Params>, $InferInterfaceInput<Shape, Params>> {
  subtype: "interface";
  def: $ZodInterfaceDef<Shape>;
  shape: Shape;
  optional: Params["optional"];
  defaulted: Params["defaulted"];
  extra: Params["extra"];
}

export interface $ZodInterface<
  Shape extends Readonly<$ZodLooseShape> = Readonly<$ZodLooseShape>,
  Params extends $ZodInterfaceNamedParams = {
    optional: string;
    defaulted: string;
    extra: Record<string, unknown>;
  },
> extends $ZodType {
  _zod: $ZodInterfaceInternals<Shape, Params>;
}

export const $ZodInterface: core.$constructor<$ZodInterface> = /*@__PURE__*/ core.$constructor(
  "$ZodInterface",
  (inst, def) => {
    $ZodObjectLike.init(inst, def);
  }
);

///////////////////////////////////////////////////////
/////////////      $ZodObject      /////////////
///////////////////////////////////////////////////////

// compute output type
type OptionalOutKeys<T extends $ZodShape> = {
  [k in keyof T]: T[k] extends { _zod: { qout: "true" } } ? k : never;
}[keyof T];
type OptionalOutProps<T extends $ZodShape> = {
  [k in OptionalOutKeys<T>]?: T[k]["_zod"]["output"];
};
type RequiredOutProps<T extends $ZodShape> = {
  [k in keyof T as T[k]["_zod"]["qout"] extends "true" ? never : k]-?: T[k]["_zod"]["output"];
};
export type $InferObjectOutput<T extends $ZodShape, Extra extends Record<string, unknown>> = {} extends T
  ? object
  : util.Flatten<OptionalOutProps<T> & RequiredOutProps<T>> & Extra;

// compute input type
type OptionalInKeys<T extends $ZodShape> = {
  [k in keyof T]: T[k] extends { _zod: { qin: "true" } } ? k : never;
}[keyof T];
type OptionalInProps<T extends $ZodShape> = {
  [k in OptionalInKeys<T>]?: T[k]["_zod"]["input"];
};
type RequiredInKeys<T extends $ZodShape> = {
  [k in keyof T]: T[k] extends { _zod: { qin: "true" } } ? never : k;
}[keyof T];
type RequiredInProps<T extends $ZodShape> = {
  [k in RequiredInKeys<T>]: T[k]["_zod"]["input"];
};
export type $InferObjectInput<T extends $ZodShape, Extra extends Record<string, unknown>> = util.Flatten<
  ({} extends T ? object : OptionalInProps<T> & RequiredInProps<T>) & Extra
>;

export interface $ZodObjectDef<Shape extends $ZodShape = $ZodShape> extends $ZodObjectLikeDef<Shape> {
  type: "object";
  shape: Shape;
}

export interface $ZodObjectInternals<
  Shape extends $ZodShape = $ZodShape,
  Extra extends Record<string, unknown> = Record<string, unknown>,
> extends $ZodObjectLikeInternals<$InferObjectOutput<Shape, Extra>, $InferObjectInput<Shape, Extra>> {
  subtype: "object";
  def: $ZodObjectDef<Shape>;
  extra: Extra;
}

export interface $ZodObject<
  Shape extends $ZodShape = $ZodShape,
  Extra extends Record<string, unknown> = Record<string, unknown>,
> extends $ZodType {
  _zod: $ZodObjectInternals<Shape, Extra>;
}

export const $ZodObject: core.$constructor<$ZodObject> = /*@__PURE__*/ core.$constructor("$ZodObject", (inst, def) => {
  $ZodObjectLike.init(inst, def);
});

/////////////////////////////////////////
/////////////////////////////////////////
//////////                    ///////////
//////////      $ZodUnion      //////////
//////////                    ///////////
/////////////////////////////////////////
/////////////////////////////////////////
export interface $ZodUnionDef<Options extends readonly $ZodType[] = readonly $ZodType[]> extends $ZodTypeDef {
  type: "union";
  options: Options;
}

export interface $ZodUnionInternals<T extends readonly $ZodType[] = readonly $ZodType[]>
  extends $ZodTypeInternals<T[number]["_zod"]["output"], T[number]["_zod"]["input"]> {
  def: $ZodUnionDef<T>;
  isst: errors.$ZodIssueInvalidUnion;
  pattern: T[number]["_zod"]["pattern"];
}

export interface $ZodUnion<T extends readonly $ZodType[] = readonly $ZodType[]> extends $ZodType {
  _zod: $ZodUnionInternals<T>;
}

function handleUnionResults(results: ParsePayload[], final: ParsePayload, inst: $ZodUnion, ctx?: ParseContext) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }

  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => util.finalizeIssue(iss, ctx, core.config()))),
  });

  return final;
}

export const $ZodUnion: core.$constructor<$ZodUnion> = /*@__PURE__*/ core.$constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);

  const values = new Set<util.Primitive>();
  if (def.options.every((o) => o._zod.values)) {
    for (const option of def.options) {
      for (const v of option._zod.values!) {
        values.add(v);
      }
    }
    inst._zod.values = values;
  }

  // computed union regex for pattern if all options have pattern
  if (def.options.every((o) => o._zod.pattern)) {
    const patterns = def.options.map((o) => o._zod.pattern);
    inst._zod.pattern = new RegExp(`^(${patterns.map((p) => util.cleanRegex(p!.source)).join("|")})$`);
  }

  inst._zod.parse = (payload, ctx) => {
    const async = false;

    const results: util.MaybeAsync<ParsePayload>[] = [];
    for (const option of def.options) {
      const result = option._zod.run(
        {
          value: payload.value,
          issues: [],
        },
        ctx
      );
      if (result instanceof Promise) {
        results.push(result);
      } else {
        if (result.issues.length === 0) return result;
        results.push(result);
      }
    }

    if (!async) return handleUnionResults(results as ParsePayload[], payload, inst, ctx);
    return Promise.all(results).then((results) => {
      return handleUnionResults(results as ParsePayload[], payload, inst, ctx);
    });
  };
});

//////////////////////////////////////////////////////
//////////////////////////////////////////////////////
//////////                                  //////////
//////////      $ZodDiscriminatedUnion      //////////
//////////                                  //////////
//////////////////////////////////////////////////////
//////////////////////////////////////////////////////

export interface $ZodDiscriminatedUnionDef<Options extends readonly $ZodType[] = readonly $ZodType[]>
  extends $ZodUnionDef<Options> {
  unionFallback?: boolean;
}

export interface $ZodDiscriminatedUnionInternals<Options extends readonly $ZodType[] = readonly $ZodType[]>
  extends $ZodUnionInternals<Options> {
  def: $ZodDiscriminatedUnionDef<Options>;
  disc: util.DiscriminatorMap;
}

export interface $ZodDiscriminatedUnion<T extends readonly $ZodType[] = readonly $ZodType[]> extends $ZodType {
  _zod: $ZodDiscriminatedUnionInternals<T>;
}

function matchDiscriminators(input: any, discs: util.DiscriminatorMap): boolean {
  for (const [key, value] of discs) {
    const data = input?.[key];
    if (value.values.has(data)) return true;
    if (value.maps.length > 0) {
      for (const m of value.maps) {
        if (matchDiscriminators(data, m)) return true;
      }
    }
  }
  return false;
}

export const $ZodDiscriminatedUnion: core.$constructor<$ZodDiscriminatedUnion> =
  /*@__PURE__*/
  core.$constructor("$ZodDiscriminatedUnion", (inst, def) => {
    $ZodUnion.init(inst, def);

    const _super = inst._zod.parse;
    const _disc: util.DiscriminatorMap = new Map();
    for (const el of def.options) {
      if (!el._zod.disc) throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(el)}"`);
      for (const [key, o] of el._zod.disc) {
        if (!_disc.has(key))
          _disc.set(key, {
            values: new Set(),
            maps: [],
          });
        const _o = _disc.get(key)!;
        for (const v of o.values) {
          // Removed to account for unions of unions
          // Some schemas may have the same discriminator value in this case
          _o.values.add(v);
        }
        for (const m of o.maps) _o.maps.push(m);
      }
    }
    inst._zod.disc = _disc;

    const discMap: Map<$ZodType, util.DiscriminatorMap> = new Map();
    for (const option of def.options) {
      const disc = option._zod.disc;
      if (!disc) {
        throw new Error(`Invalid disciminated union element: ${option._zod.def.type}`);
      }
      discMap.set(option, disc);
    }

    inst._zod.parse = (payload, ctx) => {
      const input = payload.value;
      if (!util.isObject(input)) {
        payload.issues.push({
          code: "invalid_type",
          expected: "object",
          input,
          inst,
        });
        return payload;
      }

      const filteredOptions: $ZodType[] = [];
      for (const option of def.options) {
        if (discMap.has(option)) {
          if (matchDiscriminators(input, discMap.get(option)!)) {
            filteredOptions.push(option);
          }
        } else {
          // no discriminator
          filteredOptions.push(option);
        }
      }

      if (filteredOptions.length === 1) return filteredOptions[0]._zod.run(payload, ctx) as any;

      if (def.unionFallback) {
        return _super(payload, ctx);
      }
      payload.issues.push({
        code: "invalid_union",
        errors: [],
        note: "No matching discriminator",
        input,
        inst,
      });
      return payload;
    };
  });

////////////////////////////////////////////////
////////////////////////////////////////////////
//////////                            //////////
//////////      $ZodIntersection      //////////
//////////                            //////////
////////////////////////////////////////////////
////////////////////////////////////////////////

export interface $ZodIntersectionDef extends $ZodTypeDef {
  type: "intersection";
  left: $ZodType;
  right: $ZodType;
}

export interface $ZodIntersectionInternals<A extends $ZodType = $ZodType, B extends $ZodType = $ZodType>
  extends $ZodTypeInternals<A["_zod"]["output"] & B["_zod"]["output"], A["_zod"]["input"] & B["_zod"]["input"]> {
  def: $ZodIntersectionDef;
  isst: never;
}

export interface $ZodIntersection<A extends $ZodType = $ZodType, B extends $ZodType = $ZodType> extends $ZodType {
  _zod: $ZodIntersectionInternals<A, B>;
}

export const $ZodIntersection: core.$constructor<$ZodIntersection> = /*@__PURE__*/ core.$constructor(
  "$ZodIntersection",
  (inst, def) => {
    $ZodType.init(inst, def);

    inst._zod.parse = (payload, ctx) => {
      const { value: input } = payload;
      const left = def.left._zod.run({ value: input, issues: [] }, ctx);
      const right = def.right._zod.run({ value: input, issues: [] }, ctx);
      const async = left instanceof Promise || right instanceof Promise;

      if (async) {
        return Promise.all([left, right]).then(([left, right]) => {
          return handleIntersectionResults(payload, left, right);
        });
      }

      return handleIntersectionResults(payload, left, right);
    };
  }
);

function mergeValues(
  a: any,
  b: any
): { valid: true; data: any } | { valid: false; mergeErrorPath: (string | number)[] } {
  // const aType = parse.t(a);
  // const bType = parse.t(b);

  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (util.isPlainObject(a) && util.isPlainObject(b)) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);

    const newObj: any = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath],
        };
      }
      newObj[key] = sharedValue.data;
    }

    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }

    const newArray: unknown[] = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);

      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath],
        };
      }

      newArray.push(sharedValue.data);
    }

    return { valid: true, data: newArray };
  }

  return { valid: false, mergeErrorPath: [] };
}

function handleIntersectionResults(result: ParsePayload, left: ParsePayload, right: ParsePayload): ParsePayload {
  if (left.issues.length) {
    result.issues.push(...left.issues);
  }
  if (right.issues.length) {
    result.issues.push(...right.issues);
  }
  if (util.aborted(result)) return result;

  const merged = mergeValues(left.value, right.value);

  if (!merged.valid) {
    throw new Error(`Unmergable intersection. Error path: ` + `${JSON.stringify(merged.mergeErrorPath)}`);
  }

  result.value = merged.data;
  return result;
}

/////////////////////////////////////////
/////////////////////////////////////////
//////////                     //////////
//////////      $ZodTuple      //////////
//////////                     //////////
/////////////////////////////////////////
/////////////////////////////////////////

export interface $ZodTupleDef<
  T extends util.TupleItems = util.TupleItems,
  Rest extends $ZodType | null = $ZodType | null,
> extends $ZodTypeDef {
  type: "tuple";
  items: T;
  rest: Rest;
}

export type $InferTupleInputType<T extends util.TupleItems, Rest extends $ZodType | null> = [
  ...TupleInputTypeWithOptionals<T>,
  ...(Rest extends $ZodType ? Rest["_zod"]["input"][] : []),
];
type TupleInputTypeNoOptionals<T extends util.TupleItems> = {
  [k in keyof T]: T[k]["_zod"]["input"];
};
type TupleInputTypeWithOptionals<T extends util.TupleItems> = T extends readonly [
  ...infer Prefix extends $ZodType[],
  infer Tail extends $ZodType,
]
  ? Tail["_zod"]["qin"] extends "true"
    ? [...TupleInputTypeWithOptionals<Prefix>, Tail["_zod"]["input"]?]
    : TupleInputTypeNoOptionals<T>
  : [];

export type $InferTupleOutputType<T extends util.TupleItems, Rest extends $ZodType | null> = [
  ...TupleOutputTypeWithOptionals<T>,
  ...(Rest extends $ZodType ? Rest["_zod"]["output"][] : []),
];
type TupleOutputTypeNoOptionals<T extends util.TupleItems> = {
  [k in keyof T]: T[k]["_zod"]["output"];
};
type TupleOutputTypeWithOptionals<T extends util.TupleItems> = T extends readonly [
  ...infer Prefix extends $ZodType[],
  infer Tail extends $ZodType,
]
  ? Tail["_zod"]["qout"] extends "true"
    ? [...TupleOutputTypeWithOptionals<Prefix>, Tail["_zod"]["output"]?]
    : TupleOutputTypeNoOptionals<T>
  : [];

export interface $ZodTupleInternals<
  T extends util.TupleItems = util.TupleItems,
  Rest extends $ZodType | null = $ZodType | null,
> extends $ZodTypeInternals<$InferTupleOutputType<T, Rest>, $InferTupleInputType<T, Rest>> {
  def: $ZodTupleDef<T, Rest>;
  isst: errors.$ZodIssueInvalidType | errors.$ZodIssueTooBig<unknown[]> | errors.$ZodIssueTooSmall<unknown[]>;
}

export interface $ZodTuple<T extends util.TupleItems = util.TupleItems, Rest extends $ZodType | null = $ZodType | null>
  extends $ZodType {
  _zod: $ZodTupleInternals<T, Rest>;
}

export const $ZodTuple: core.$constructor<$ZodTuple> = /*@__PURE__*/ core.$constructor("$ZodTuple", (inst, def) => {
  $ZodType.init(inst, def);
  const items = def.items;
  const optStart = items.length - [...items].reverse().findIndex((item) => item._zod.qout !== "true");

  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        input,
        inst,
        expected: "tuple",
        code: "invalid_type",
      });
      return payload;
    }

    payload.value = [];
    const proms: Promise<any>[] = [];

    if (!def.rest) {
      const tooBig = input.length > items.length;
      const tooSmall = input.length < optStart - 1;
      if (tooBig || tooSmall) {
        payload.issues.push({
          input,
          inst,
          origin: "array" as const,
          ...(tooBig ? { code: "too_big", maximum: items.length } : { code: "too_small", minimum: items.length }),
        });
        return payload;
      }
    }

    let i = -1;
    for (const item of items) {
      i++;
      if (i >= input.length) if (i >= optStart) continue;
      const result = item._zod.run(
        {
          value: input[i],
          issues: [],
        },
        ctx
      );

      if (result instanceof Promise) {
        proms.push(result.then((result) => handleTupleResult(result, payload, i)));
      } else {
        handleTupleResult(result, payload, i);
      }
    }

    if (def.rest) {
      const rest = input.slice(items.length);
      for (const el of rest) {
        i++;
        const result = def.rest._zod.run(
          {
            value: el,
            issues: [],
          },
          ctx
        );

        if (result instanceof Promise) {
          proms.push(result.then((result) => handleTupleResult(result, payload, i)));
        } else {
          handleTupleResult(result, payload, i);
        }
      }
    }

    if (proms.length) return Promise.all(proms).then(() => payload);
    return payload;
  };
});

function handleTupleResult(result: ParsePayload, final: ParsePayload<any[]>, index: number) {
  if (result.issues.length) {
    final.issues.push(...util.prefixIssues(index, result.issues));
  } else {
    final.value[index] = result.value;
  }
}

//////////////////////////////////////////
//////////////////////////////////////////
//////////                      //////////
//////////      $ZodRecord      //////////
//////////                      //////////
//////////////////////////////////////////
//////////////////////////////////////////

export type $ZodRecordKey = $ZodType<string | number | symbol, string | number | symbol>; // $HasValues | $HasPattern;
export interface $ZodRecordDef extends $ZodTypeDef {
  type: "record";
  keyType: $ZodRecordKey;
  valueType: $ZodType;
}

export interface $ZodRecordInternals<Key extends $ZodRecordKey = $ZodRecordKey, Value extends $ZodType = $ZodType>
  extends $ZodTypeInternals<
    Record<Key["_zod"]["output"], Value["_zod"]["output"]>,
    Record<Key["_zod"]["input"], Value["_zod"]["input"]>
  > {
  def: $ZodRecordDef;
  isst: errors.$ZodIssueInvalidType | errors.$ZodIssueInvalidKey<Record<PropertyKey, unknown>>;
}

export interface $ZodRecord<Key extends $ZodRecordKey = $ZodRecordKey, Value extends $ZodType = $ZodType>
  extends $ZodType {
  _zod: $ZodRecordInternals<Key, Value>;
}

export const $ZodRecord: core.$constructor<$ZodRecord> = /*@__PURE__*/ core.$constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);

  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;

    if (!util.isPlainObject(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst,
      });
      return payload;
    }

    const proms: Promise<any>[] = [];

    if (def.keyType._zod.values) {
      const values = def.keyType._zod.values!;
      payload.value = {};
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);

          if (result instanceof Promise) {
            proms.push(
              result.then((result) => {
                if (result.issues.length) {
                  payload.issues.push(...util.prefixIssues(key, result.issues));
                }
                payload.value[key] = result.value;
              })
            );
          } else {
            if (result.issues.length) {
              payload.issues.push(...util.prefixIssues(key, result.issues));
            }
            payload.value[key] = result.value;
          }
        }
      }

      let unrecognized!: string[];
      for (const key in input) {
        if (!values.has(key)) {
          unrecognized = unrecognized ?? [];
          unrecognized.push(key);
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
        });
      }
    } else {
      payload.value = {};
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__") continue;
        const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);

        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }

        if (keyResult.issues.length) {
          payload.issues.push({
            origin: "record",
            code: "invalid_key",
            issues: keyResult.issues.map((iss) => util.finalizeIssue(iss, ctx, core.config())),
            input: key,
            path: [key],
            inst,
          });
          continue;
        }

        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);

        if (result instanceof Promise) {
          proms.push(
            result.then((result) => {
              if (result.issues.length) {
                payload.issues.push(...util.prefixIssues(key, result.issues));
              } else {
                payload.value[keyResult.value as PropertyKey] = result.value;
              }
            })
          );
        } else {
          if (result.issues.length) {
            payload.issues.push(...util.prefixIssues(key, result.issues));
          } else {
            payload.value[keyResult.value as PropertyKey] = result.value;
          }
        }
      }
    }

    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});

///////////////////////////////////////
///////////////////////////////////////
//////////                   //////////
//////////      $ZodMap      //////////
//////////                   //////////
///////////////////////////////////////
///////////////////////////////////////
export interface $ZodMapDef extends $ZodTypeDef {
  type: "map";
  keyType: $ZodType;
  valueType: $ZodType;
}

export interface $ZodMapInternals<Key extends $ZodType = $ZodType, Value extends $ZodType = $ZodType>
  extends $ZodTypeInternals<
    Map<Key["_zod"]["output"], Value["_zod"]["output"]>,
    Map<Key["_zod"]["input"], Value["_zod"]["input"]>
  > {
  def: $ZodMapDef;
  isst: errors.$ZodIssueInvalidType | errors.$ZodIssueInvalidKey | errors.$ZodIssueInvalidElement<unknown>;
}

export interface $ZodMap<Key extends $ZodType = $ZodType, Value extends $ZodType = $ZodType> extends $ZodType {
  _zod: $ZodMapInternals<Key, Value>;
}

export const $ZodMap: core.$constructor<$ZodMap> = /*@__PURE__*/ core.$constructor("$ZodMap", (inst, def) => {
  $ZodType.init(inst, def);

  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!(input instanceof Map)) {
      payload.issues.push({
        expected: "map",
        code: "invalid_type",
        input,
        inst,
      });
      return payload;
    }

    const proms: Promise<any>[] = [];
    payload.value = new Map();

    for (const [key, value] of input) {
      const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
      const valueResult = def.valueType._zod.run({ value: value, issues: [] }, ctx);

      if (keyResult instanceof Promise || valueResult instanceof Promise) {
        proms.push(
          Promise.all([keyResult, valueResult]).then(([keyResult, valueResult]) => {
            handleMapResult(keyResult, valueResult, payload, key, input, inst, ctx);
          })
        );
      } else {
        handleMapResult(keyResult as ParsePayload, valueResult as ParsePayload, payload, key, input, inst, ctx);
      }
    }

    if (proms.length) return Promise.all(proms).then(() => payload);
    return payload;
  };
});

function handleMapResult(
  keyResult: ParsePayload,
  valueResult: ParsePayload,
  final: ParsePayload<Map<unknown, unknown>>,
  key: unknown,
  input: Map<any, any>,
  inst: $ZodMap,
  ctx?: ParseContext | undefined
): void {
  if (keyResult.issues.length) {
    if (util.propertyKeyTypes.has(typeof key)) {
      final.issues.push(...util.prefixIssues(key as PropertyKey, keyResult.issues));
    } else {
      final.issues.push({
        origin: "map",
        code: "invalid_key",
        input,
        inst,
        issues: keyResult.issues.map((iss) => util.finalizeIssue(iss, ctx, core.config())),
      });
    }
  }
  if (valueResult.issues.length) {
    if (util.propertyKeyTypes.has(typeof key)) {
      final.issues.push(...util.prefixIssues(key as PropertyKey, valueResult.issues));
    } else {
      final.issues.push({
        origin: "map",
        code: "invalid_element",
        input,
        inst,
        key: key,
        issues: valueResult.issues.map((iss) => util.finalizeIssue(iss, ctx, core.config())),
      });
    }
  } else {
    final.value.set(keyResult.value, valueResult.value);
  }
}

///////////////////////////////////////
///////////////////////////////////////
//////////                   //////////
//////////      $ZodSet      //////////
//////////                   //////////
///////////////////////////////////////
///////////////////////////////////////
export interface $ZodSetDef extends $ZodTypeDef {
  type: "set";
  valueType: $ZodType;
}

export interface $ZodSetInternals<T extends $ZodType = $ZodType>
  extends $ZodTypeInternals<Set<T["_zod"]["output"]>, Set<T["_zod"]["input"]>> {
  def: $ZodSetDef;
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodSet<T extends $ZodType = $ZodType> extends $ZodType {
  _zod: $ZodSetInternals<T>;
}

export const $ZodSet: core.$constructor<$ZodSet> = /*@__PURE__*/ core.$constructor("$ZodSet", (inst, def) => {
  $ZodType.init(inst, def);

  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!(input instanceof Set)) {
      payload.issues.push({
        input,
        inst,
        expected: "set",
        code: "invalid_type",
      });
      return payload;
    }

    const proms: Promise<any>[] = [];
    payload.value = new Set();
    for (const item of input) {
      const result = def.valueType._zod.run({ value: item, issues: [] }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result) => handleSetResult(result, payload)));
      } else handleSetResult(result, payload);
    }

    if (proms.length) return Promise.all(proms).then(() => payload);
    return payload;
  };
});

function handleSetResult(result: ParsePayload, final: ParsePayload<Set<any>>) {
  if (result.issues.length) {
    final.issues.push(...result.issues);
  } else {
    final.value.add(result.value);
  }
}

////////////////////////////////////////
////////////////////////////////////////
//////////                    //////////
//////////      $ZodEnum      //////////
//////////                    //////////
////////////////////////////////////////
////////////////////////////////////////
export type $InferEnumOutput<T extends util.EnumLike> = T[keyof T];
export type $InferEnumInput<T extends util.EnumLike> = $InferEnumOutput<T>;

export interface $ZodEnumDef<T extends util.EnumLike = util.EnumLike> extends $ZodTypeDef {
  type: "enum";
  entries: T;
}

export interface $ZodEnumInternals<T extends util.EnumLike = util.EnumLike>
  extends $ZodTypeInternals<$InferEnumOutput<T>, $InferEnumInput<T>> {
  // enum: T;

  def: $ZodEnumDef<T>;
  /** @deprecated Internal API, use with caution (not deprecated) */
  values: util.PrimitiveSet;
  /** @deprecated Internal API, use with caution (not deprecated) */
  pattern: RegExp;
  isst: errors.$ZodIssueInvalidValue;
}

export interface $ZodEnum<T extends util.EnumLike = util.EnumLike> extends $ZodType {
  _zod: $ZodEnumInternals<T>;
}

export const $ZodEnum: core.$constructor<$ZodEnum> = /*@__PURE__*/ core.$constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);

  const values = Object.entries(def.entries)
    // remove reverse mappings
    .filter(([k, _]) => {
      return typeof def.entries[def.entries[k]] !== "number";
    })
    .map(([_, v]) => v);
  inst._zod.values = new Set<util.Primitive>(values);

  inst._zod.pattern = new RegExp(
    `^(${values
      .filter((k) => util.propertyKeyTypes.has(typeof k))
      .map((o) => (typeof o === "string" ? util.escapeRegex(o) : o.toString()))
      .join("|")})$`
  );

  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (inst._zod.values.has(input as any)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst,
    });
    return payload;
  };
});

////////////////////////////////////////
////////////////////////////////////////
//////////                    //////////
//////////      $ZodLiteral      //////////
//////////                    //////////
////////////////////////////////////////
////////////////////////////////////////

export interface $ZodLiteralDef extends $ZodTypeDef {
  type: "literal";
  values: util.LiteralArray;
}

export interface $ZodLiteralInternals<T extends util.Primitive = util.Primitive> extends $ZodTypeInternals<T, T> {
  def: $ZodLiteralDef;
  values: util.PrimitiveSet;
  pattern: RegExp;
  isst: errors.$ZodIssueInvalidValue;
}

export interface $ZodLiteral<T extends util.Primitive = util.Primitive> extends $ZodType {
  _zod: $ZodLiteralInternals<T>;
}

export const $ZodLiteral: core.$constructor<$ZodLiteral> = /*@__PURE__*/ core.$constructor(
  "$ZodLiteral",
  (inst, def) => {
    $ZodType.init(inst, def);

    inst._zod.values = new Set<util.Primitive>(def.values);
    inst._zod.pattern = new RegExp(
      `^(${def.values

        .map((o) => (typeof o === "string" ? util.escapeRegex(o) : o ? o.toString() : String(o)))
        .join("|")})$`
    );

    inst._zod.parse = (payload, _ctx) => {
      const input = payload.value;
      if (inst._zod.values.has(input as any)) {
        return payload;
      }
      payload.issues.push({
        code: "invalid_value",
        values: def.values,
        input,
        inst,
      });
      return payload;
    };
  }
);

////////////////////////////////////////
////////////////////////////////////////
//////////                    //////////
//////////      $ZodConst      //////////
//////////                    //////////
////////////////////////////////////////
////////////////////////////////////////

// export interface $ZodConstDef extends $ZodTypeDef {
//   type: "const";
//   value: unknown;
// }

// export _interface $ZodConstInternals<T extends util.Literal = util.Literal> extends $ZodTypeInternals<T, T> {
//   _def: $ZodConstDef;
//   _values: util.PrimitiveSet;
//   _pattern: RegExp;
//   _isst: errors.$ZodIssueInvalidValue;
// }

// export const $ZodConst: core.$constructor<{_zod: $ZodConstInternals}> = /*@__PURE__*/ core.$constructor("$ZodConst", (inst, def) => {
//   $ZodType.init(inst, def);

//   if (util.primitiveTypes.has(typeof def.value) || def.value === null) {
//     inst._zod.values = new Set<util.Primitive>(def.value as any);
//   }

//   if (util.propertyKeyTypes.has(typeof def.value)) {
//     inst._zod.pattern = new RegExp(
//       `^(${typeof def.value === "string" ? util.escapeRegex(def.value) : (def.value as any).toString()})$`
//     );
//   } else {
//     throw new Error("Const value cannot be converted to regex");
//   }

//   inst._zod.parse = (payload, _ctx) => {
//     payload.value = def.value; // always override
//     return payload;
//   };
// });

//////////////////////////////////////////
//////////////////////////////////////////
//////////                      //////////
//////////      $ZodFile        //////////
//////////                      //////////
//////////////////////////////////////////
//////////////////////////////////////////

export interface $ZodFileDef extends $ZodTypeDef {
  type: "file";
}

export interface $ZodFileInternals extends $ZodTypeInternals<File, File> {
  def: $ZodFileDef;
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodFile extends $ZodType {
  _zod: $ZodFileInternals;
}

export const $ZodFile: core.$constructor<$ZodFile> = /*@__PURE__*/ core.$constructor("$ZodFile", (inst, def) => {
  $ZodType.init(inst, def);

  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input instanceof File) return payload;
    payload.issues.push({
      expected: "file",
      code: "invalid_type",
      input,
      inst,
    });
    return payload;
  };
});

//////////////////////////////////////////////
//////////////////////////////////////////////
//////////                          //////////
//////////        $ZodTransform        //////////
//////////                          //////////
//////////////////////////////////////////////
//////////////////////////////////////////////
export interface $ZodTransformDef extends $ZodTypeDef {
  type: "transform";
  transform: (input: unknown, payload: ParsePayload<unknown>) => util.MaybeAsync<unknown>;
  abort?: boolean | undefined;
}
export interface $ZodTransformInternals<O = unknown, I = unknown> extends $ZodTypeInternals<O, I> {
  def: $ZodTransformDef;
  isst: never;
}

export interface $ZodTransform<O = unknown, I = unknown> extends $ZodType {
  _zod: $ZodTransformInternals<O, I>;
}

export const $ZodTransform: core.$constructor<$ZodTransform> = /*@__PURE__*/ core.$constructor(
  "$ZodTransform",
  (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.parse = (payload, _ctx) => {
      const _out = def.transform(payload.value, payload);

      if (_ctx.async) {
        const output = _out instanceof Promise ? _out : Promise.resolve(_out);
        return output.then((output) => {
          payload.value = output;
          return payload;
        });
      }

      if (_out instanceof Promise) {
        throw new core.$ZodAsyncError();
      }

      payload.value = _out;
      return payload;
    };
  }
);

////////////////////////////////////////////
////////////////////////////////////////////
//////////                        //////////
//////////      $ZodOptional      //////////
//////////                        //////////
////////////////////////////////////////////
////////////////////////////////////////////
export interface $ZodOptionalDef<T extends $ZodType = $ZodType> extends $ZodTypeDef {
  type: "optional";
  innerType: T;
}

export interface $ZodOptionalInternals<T extends $ZodType = $ZodType>
  extends $ZodTypeInternals<T["_zod"]["output"] | undefined, T["_zod"]["input"] | undefined> {
  def: $ZodOptionalDef<T>;
  qin: "true";
  qout: "true";
  isst: never;
  values: T["_zod"]["values"];
  pattern: RegExp;
}

export interface $ZodOptional<T extends $ZodType = $ZodType> extends $ZodType {
  _zod: $ZodOptionalInternals<T>;
}

export const $ZodOptional: core.$constructor<$ZodOptional> = /*@__PURE__*/ core.$constructor(
  "$ZodOptional",
  (inst, def) => {
    $ZodType.init(inst, def);
    // inst._zod.qin = "true";
    inst._zod.qout = "true";
    if (def.innerType._zod.values) inst._zod.values = new Set([...def.innerType._zod.values, undefined]);
    const pattern = (def.innerType as any)._zod.pattern;
    if (pattern) inst._zod.pattern = new RegExp(`^(${util.cleanRegex(pattern.source)})?$`);

    inst._zod.parse = (payload, ctx) => {
      if (payload.value === undefined) {
        return payload;
      }
      return def.innerType._zod.run(payload, ctx);
    };
  }
);

////////////////////////////////////////////
////////////////////////////////////////////
//////////                        //////////
//////////      $ZodNullable      //////////
//////////                        //////////
////////////////////////////////////////////
////////////////////////////////////////////
export interface $ZodNullableDef<T extends $ZodType = $ZodType> extends $ZodTypeDef {
  type: "nullable";
  innerType: T;
}

export interface $ZodNullableInternals<T extends $ZodType = $ZodType>
  extends $ZodTypeInternals<T["_zod"]["output"] | null, T["_zod"]["input"] | null> {
  def: $ZodNullableDef<T>;
  qin: T["_zod"]["qin"];
  qout: T["_zod"]["qout"];
  isst: never;
  values: T["_zod"]["values"];
  pattern: RegExp;
}

export interface $ZodNullable<T extends $ZodType = $ZodType> extends $ZodType {
  _zod: $ZodNullableInternals<T>;
}

export const $ZodNullable: core.$constructor<$ZodNullable> = /*@__PURE__*/ core.$constructor(
  "$ZodNullable",
  (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.qin = def.innerType._zod.qin;
    inst._zod.qout = def.innerType._zod.qout;

    const pattern = (def.innerType as any)._zod.pattern;
    if (pattern) inst._zod.pattern = new RegExp(`^(${util.cleanRegex(pattern.source)}|null)$`);

    if (def.innerType._zod.values) inst._zod.values = new Set([...def.innerType._zod.values, null]);

    inst._zod.parse = (payload, ctx) => {
      if (payload.value === null) return payload;
      return def.innerType._zod.run(payload, ctx);
    };
  }
);
// );

////////////////////////////////////////////
////////////////////////////////////////////
//////////                        //////////
//////////      $ZodDefault       //////////
//////////                        //////////
////////////////////////////////////////////
////////////////////////////////////////////
export interface $ZodDefaultDef<T extends $ZodType = $ZodType> extends $ZodTypeDef {
  type: "default";
  innerType: T;
  defaultValue: () => util.NoUndefined<T["_zod"]["output"]>;
}

export interface $ZodDefaultInternals<T extends $ZodType = $ZodType>
  extends $ZodTypeInternals<
    // this is pragmatic but not strictly correct
    util.NoUndefined<T["_zod"]["output"]>,
    T["_zod"]["input"] | undefined
  > {
  def: $ZodDefaultDef<T>;
  qin: "true";
  isst: never;
  values: T["_zod"]["values"];
}

export interface $ZodDefault<T extends $ZodType = $ZodType> extends $ZodType {
  _zod: $ZodDefaultInternals<T>;
}

export const $ZodDefault: core.$constructor<$ZodDefault> = /*@__PURE__*/ core.$constructor(
  "$ZodDefault",
  (inst, def) => {
    $ZodType.init(inst, def);

    inst._zod.values = def.innerType._zod.values;

    inst._zod.parse = (payload, ctx) => {
      if (payload.value === undefined) {
        payload.value = def.defaultValue();
        /**
         * $ZodDefault always returns the default value immediately.
         * It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
        return payload;
      }
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise) {
        return result.then((result) => handleDefaultResult(result, def));
      }
      return handleDefaultResult(result, def);
    };
  }
);

function handleDefaultResult(payload: ParsePayload, def: $ZodDefaultDef) {
  if (payload.value === undefined) {
    payload.value = def.defaultValue();
  }
  return payload;
}
///////////////////////////////////////////////
///////////////////////////////////////////////
//////////                           //////////
//////////      $ZodNonOptional      //////////
//////////                           //////////
///////////////////////////////////////////////
///////////////////////////////////////////////
export interface $ZodNonOptionalDef<T extends $ZodType = $ZodType> extends $ZodTypeDef {
  type: "nonoptional";
  innerType: T;
}

export interface $ZodNonOptionalInternals<T extends $ZodType = $ZodType>
  extends $ZodTypeInternals<util.NoUndefined<T["_zod"]["output"]>, util.NoUndefined<T["_zod"]["input"]>> {
  def: $ZodNonOptionalDef<T>;
  isst: errors.$ZodIssueInvalidType;
  values: T["_zod"]["values"];
}

export interface $ZodNonOptional<T extends $ZodType = $ZodType> extends $ZodType {
  _zod: $ZodNonOptionalInternals<T>;
}

export const $ZodNonOptional: core.$constructor<$ZodNonOptional> = /*@__PURE__*/ core.$constructor(
  "$ZodNonOptional",
  (inst, def) => {
    $ZodType.init(inst, def);
    if (def.innerType._zod.values)
      inst._zod.values = new Set([...def.innerType._zod.values].filter((x) => x !== undefined));
    inst._zod.parse = (payload, ctx) => {
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise) {
        return result.then((result) => handleNonOptionalResult(result, inst));
      }
      return handleNonOptionalResult(result, inst);
    };
  }
);

function handleNonOptionalResult(payload: ParsePayload, inst: $ZodNonOptional) {
  if (!payload.issues.length && payload.value === undefined) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst,
    });
  }
  return payload;
}

////////////////////////////////////////////
////////////////////////////////////////////
//////////                        //////////
//////////      $ZodCoalesce      //////////
//////////                        //////////
////////////////////////////////////////////
////////////////////////////////////////////
// export interface $ZodCoalesceDef<T extends $ZodType = $ZodType> extends $ZodTypeDef {
//   type: "coalesce";
//   innerType: T;
//   defaultValue: () => NonNullable<T['_zod']["output"]>;
// }

// export _interface $ZodCoalesceInternals<T extends $ZodType = $ZodType>
//   extends $ZodTypeInternals<NonNullable<T['_zod']["output"]>, T['_zod']["input"] | undefined | null> {
//   _def: $ZodCoalesceDef<T>;
//   _isst: errors.$ZodIssueInvalidType;
//   _qin: "true";
// }

// function handleCoalesceResult(payload: ParsePayload, def: $ZodCoalesceDef) {
//   payload.value ??= def.defaultValue();
//   return payload;
// }

// export const $ZodCoalesce: core.$constructor<{_zod: $ZodCoalesceInternals}> = /*@__PURE__*/ core.$constructor(
//   "$ZodCoalesce",
//   (inst, def) => {
//     $ZodType.init(inst, def);
// inst._zod.qin = "true";
//     inst._zod.parse = (payload, ctx) => {
//       const result = def.innerType._zod.run(payload, ctx);
//       if (result instanceof Promise) {
//         return result.then((result) => handleCoalesceResult(result, def));
//       }
//       return handleCoalesceResult(result, def);
//     };
//   }
// );

/////////////////////////////////////////////
/////////////////////////////////////////////
//////////                         //////////
//////////      $ZodSuccess        //////////
//////////                         //////////
/////////////////////////////////////////////
/////////////////////////////////////////////
export interface $ZodSuccessDef extends $ZodTypeDef {
  type: "success";
  innerType: $ZodType;
}

export interface $ZodSuccessInternals<T extends $ZodType = $ZodType>
  extends $ZodTypeInternals<boolean, T["_zod"]["input"]> {
  def: $ZodSuccessDef;
  isst: never;
}

export interface $ZodSuccess<T extends $ZodType = $ZodType> extends $ZodType {
  _zod: $ZodSuccessInternals<T>;
}

export const $ZodSuccess: core.$constructor<$ZodSuccess> = /*@__PURE__*/ core.$constructor(
  "$ZodSuccess",
  (inst, def) => {
    $ZodType.init(inst, def);

    inst._zod.parse = (payload, ctx) => {
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise) {
        return result.then((result) => {
          payload.value = result.issues.length === 0;
          return payload;
        });
      }
      payload.value = result.issues.length === 0;
      return payload;
    };
  }
);

////////////////////////////////////////////
////////////////////////////////////////////
//////////                        //////////
//////////       $ZodCatch        //////////
//////////                        //////////
////////////////////////////////////////////
////////////////////////////////////////////
export interface $ZodCatchCtx extends ParsePayload {
  /** @deprecated Use `ctx.issues` */
  error: { issues: errors.$ZodIssue[] };
  /** @deprecated Use `ctx.value` */
  input: unknown;
}
export interface $ZodCatchDef extends $ZodTypeDef {
  type: "catch";
  innerType: $ZodType;
  catchValue: (ctx: $ZodCatchCtx) => unknown;
}

export interface $ZodCatchInternals<T extends $ZodType = $ZodType>
  extends $ZodTypeInternals<T["_zod"]["output"], util.Loose<T["_zod"]["input"]>> {
  def: $ZodCatchDef;
  qin: T["_zod"]["qin"];
  qout: T["_zod"]["qout"];
  isst: never;
  values: T["_zod"]["values"];
}

export interface $ZodCatch<T extends $ZodType = $ZodType> extends $ZodType {
  _zod: $ZodCatchInternals<T>;
}

export const $ZodCatch: core.$constructor<$ZodCatch> = /*@__PURE__*/ core.$constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  // inst._zod.qin = def.innerType._zod.qin;
  inst._zod.qout = def.innerType._zod.qout;
  inst._zod.values = def.innerType._zod.values;

  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => {
        if (result.issues.length) {
          payload.value = def.catchValue({
            ...payload,
            error: { issues: result.issues.map((iss) => util.finalizeIssue(iss, ctx, core.config())) },
            input: payload.value,
          });
          payload.issues = [];
        } else {
          payload.value = result.value;
        }
        return payload;
      });
    }

    if (result.issues.length) {
      payload.value = def.catchValue({
        ...payload,
        error: { issues: result.issues.map((iss) => util.finalizeIssue(iss, ctx, core.config())) },
        input: payload.value,
      });
      payload.issues = [];
    } else {
      payload.value = result.value;
    }
    return payload;
  };
});

////////////////////////////////////////////
////////////////////////////////////////////
//////////                        //////////
//////////        $ZodNaN         //////////
//////////                        //////////
////////////////////////////////////////////
////////////////////////////////////////////
export interface $ZodNaNDef extends $ZodTypeDef {
  type: "nan";
}

export interface $ZodNaNInternals extends $ZodTypeInternals<number, number> {
  def: $ZodNaNDef;
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodNaN extends $ZodType {
  _zod: $ZodNaNInternals;
}

export const $ZodNaN: core.$constructor<$ZodNaN> = /*@__PURE__*/ core.$constructor("$ZodNaN", (inst, def) => {
  $ZodType.init(inst, def);

  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "number" || !Number.isNaN(payload.value)) {
      payload.issues.push({
        input: payload.value,
        inst,
        expected: "nan",
        code: "invalid_type",
      });
      return payload;
    }
    return payload;
  };
});

////////////////////////////////////////////
////////////////////////////////////////////
//////////                        //////////
//////////      $ZodPipe      //////////
//////////                        //////////
////////////////////////////////////////////
////////////////////////////////////////////
export interface $ZodPipeDef<A extends $ZodType = $ZodType, B extends $ZodType = $ZodType> extends $ZodTypeDef {
  type: "pipe";
  in: A;
  out: B;
}

export interface $ZodPipeInternals<A extends $ZodType = $ZodType, B extends $ZodType = $ZodType>
  extends $ZodTypeInternals<B["_zod"]["output"], A["_zod"]["input"]> {
  def: $ZodPipeDef<A, B>;
  isst: never;
  values: A["_zod"]["values"];
}

export interface $ZodPipe<A extends $ZodType = $ZodType, B extends $ZodType = $ZodType> extends $ZodType {
  _zod: $ZodPipeInternals<A, B>;
}

export const $ZodPipe: core.$constructor<$ZodPipe> = /*@__PURE__*/ core.$constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  // inst._zod.qin = def.in._zod.qin;
  // inst._zod.qout = def.in._zod.qout;
  inst._zod.values = def.in._zod.values;

  inst._zod.parse = (payload, ctx) => {
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left) => handlePipeResult(left, def, ctx));
    }
    return handlePipeResult(left, def, ctx);
  };
});

function handlePipeResult(left: ParsePayload, def: $ZodPipeDef, ctx: ParseContext) {
  if (util.aborted(left)) {
    return left;
  }

  return def.out._zod.run({ value: left.value, issues: left.issues }, ctx);
}

////////////////////////////////////////////
////////////////////////////////////////////
//////////                        //////////
//////////      $ZodReadonly      //////////
//////////                        //////////
////////////////////////////////////////////
////////////////////////////////////////////

export interface $ZodReadonlyDef extends $ZodTypeDef {
  type: "readonly";
  innerType: $ZodType;
}

export interface $ZodReadonlyInternals<T extends $ZodType = $ZodType>
  extends $ZodTypeInternals<util.MakeReadonly<T["_zod"]["output"]>, util.MakeReadonly<T["_zod"]["input"]>> {
  def: $ZodReadonlyDef;
  qin: T["_zod"]["qin"];
  qout: T["_zod"]["qout"];
  isst: never;
}

export interface $ZodReadonly<T extends $ZodType = $ZodType> extends $ZodType {
  _zod: $ZodReadonlyInternals<T>;
}

export const $ZodReadonly: core.$constructor<$ZodReadonly> = /*@__PURE__*/ core.$constructor(
  "$ZodReadonly",
  (inst, def) => {
    $ZodType.init(inst, def);
    // inst._zod.qin = def.innerType._zod.qin;
    inst._zod.qout = def.innerType._zod.qout;

    inst._zod.parse = (payload, ctx) => {
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise) {
        return result.then(handleReadonlyResult);
      }
      return handleReadonlyResult(result);
    };
  }
);

function handleReadonlyResult(payload: ParsePayload): ParsePayload {
  payload.value = Object.freeze(payload.value);
  return payload;
}

/////////////////////////////////////////////
/////////////////////////////////////////////
//////////                         //////////
//////////   $ZodTemplateLiteral   //////////
//////////                         //////////
/////////////////////////////////////////////
/////////////////////////////////////////////

export interface $ZodTemplateLiteralDef extends $ZodTypeDef {
  type: "template_literal";
  parts: $TemplateLiteralPart[];
}
export interface $ZodTemplateLiteralInternals<Template extends string = string>
  extends $ZodTypeInternals<Template, Template> {
  pattern: RegExp;
  def: $ZodTemplateLiteralDef;
  isst: errors.$ZodIssueInvalidType;
}

export interface $ZodTemplateLiteral<Template extends string = string> extends $ZodType {
  _zod: $ZodTemplateLiteralInternals<Template>;
}

export type $LiteralPart = Exclude<util.Literal, symbol>; //string | number | boolean | null | undefined;
interface _$SchemaPart extends $ZodTypeInternals<$LiteralPart, $LiteralPart> {
  pattern: RegExp;
}
export interface $SchemaPart extends $ZodType {
  _zod: _$SchemaPart;
}
export type $TemplateLiteralPart = $LiteralPart | $SchemaPart;

type UndefinedToEmptyString<T> = T extends undefined ? "" : T;
type AppendToTemplateLiteral<
  Template extends string,
  Suffix extends $LiteralPart | $ZodType,
> = Suffix extends $LiteralPart
  ? `${Template}${UndefinedToEmptyString<Suffix>}`
  : Suffix extends $ZodType
    ? `${Template}${UndefinedToEmptyString<$LiteralPart & Suffix["_zod"]["output"]>}`
    : never;

export type $PartsToTemplateLiteral<Parts extends $TemplateLiteralPart[]> = [] extends Parts
  ? ``
  : Parts extends [...infer Rest extends $TemplateLiteralPart[], infer Last extends $TemplateLiteralPart]
    ? AppendToTemplateLiteral<$PartsToTemplateLiteral<Rest>, Last>
    : never;

export const $ZodTemplateLiteral: core.$constructor<$ZodTemplateLiteral> = /*@__PURE__*/ core.$constructor(
  "$ZodTemplateLiteral",
  (inst, def) => {
    $ZodType.init(inst, def);
    const regexParts: string[] = [];
    for (const part of def.parts) {
      if (part instanceof $ZodType) {
        if (!part._zod.pattern) {
          // if (!source)
          throw new Error(`Invalid template literal part, no pattern found: ${[...(part as any)._zod.traits].shift()}`);
        }

        const source = part._zod.pattern instanceof RegExp ? part._zod.pattern.source : part._zod.pattern;

        if (!source) throw new Error(`Invalid template literal part: ${part._zod.traits}`);

        const start = source.startsWith("^") ? 1 : 0;
        const end = source.endsWith("$") ? source.length - 1 : source.length;
        regexParts.push(source.slice(start, end));
      } else if (part === null || util.primitiveTypes.has(typeof part)) {
        regexParts.push(util.escapeRegex(`${part}`));
      } else {
        throw new Error(`Invalid template literal part: ${part}`);
      }
    }
    inst._zod.pattern = new RegExp(`^${regexParts.join("")}$`);

    inst._zod.parse = (payload, _ctx) => {
      if (typeof payload.value !== "string") {
        payload.issues.push({
          input: payload.value,
          inst,
          expected: "template_literal",
          code: "invalid_type",
        });
        return payload;
      }

      inst._zod.pattern.lastIndex = 0;

      if (!inst._zod.pattern.test(payload.value)) {
        payload.issues.push({
          input: payload.value,
          inst,
          expected: "template_literal",
          code: "invalid_type",
          pattern: inst._zod.pattern,
        });
        return payload;
      }

      return payload;
    };
  }
);

/////////////////////////////////////////
/////////////////////////////////////////
//////////                     //////////
//////////     $ZodPromise     //////////
//////////                     //////////
/////////////////////////////////////////
/////////////////////////////////////////
export interface $ZodPromiseDef extends $ZodTypeDef {
  type: "promise";
  innerType: $ZodType;
}

export interface $ZodPromiseInternals<T extends $ZodType = $ZodType>
  extends $ZodTypeInternals<T["_zod"]["output"], util.MaybeAsync<T["_zod"]["input"]>> {
  def: $ZodPromiseDef;
  isst: never;
}

export interface $ZodPromise<T extends $ZodType = $ZodType> extends $ZodType {
  _zod: $ZodPromiseInternals<T>;
}

export const $ZodPromise: core.$constructor<$ZodPromise> = /*@__PURE__*/ core.$constructor(
  "$ZodPromise",
  (inst, def) => {
    $ZodType.init(inst, def);

    inst._zod.parse = (payload, ctx) => {
      return Promise.resolve(payload.value).then((inner) => def.innerType._zod.run({ value: inner, issues: [] }, ctx));
    };
  }
);

//////////////////////////////////////////
//////////////////////////////////////////
//////////                      //////////
//////////      $ZodLazy        //////////
//////////                      //////////
//////////////////////////////////////////
//////////////////////////////////////////

export interface $ZodLazyDef extends $ZodTypeDef {
  type: "lazy";
  getter: () => $ZodType;
}

export interface $ZodLazyInternals<T extends $ZodType = $ZodType>
  extends $ZodTypeInternals<T["_zod"]["output"], T["_zod"]["input"]> {
  def: $ZodLazyDef;
  isst: never;
  _getter: T;
  pattern: T["_zod"]["pattern"];
  disc: T["_zod"]["disc"];
}

export interface $ZodLazy<T extends $ZodType = $ZodType> extends $ZodType {
  _zod: $ZodLazyInternals<T>;
}

export const $ZodLazy: core.$constructor<$ZodLazy> = /*@__PURE__*/ core.$constructor("$ZodLazy", (inst, def) => {
  $ZodType.init(inst, def);

  util.defineLazy(inst._zod, "_getter", def.getter);
  util.defineLazy(inst._zod, "pattern", () => inst._zod._getter._zod.pattern);
  util.defineLazy(inst._zod, "disc", () => inst._zod._getter._zod.disc);
  inst._zod.parse = (payload, ctx) => {
    return inst._zod._getter._zod.run(payload, ctx);
  };
});

////////////////////////////////////////
////////////////////////////////////////
//////////                    //////////
//////////     $ZodCustom     //////////
//////////                    //////////
////////////////////////////////////////
////////////////////////////////////////
export interface $ZodCustomDef<O = unknown> extends $ZodTypeDef, checks.$ZodCheckDef {
  type: "custom";
  check: "custom";
  path?: PropertyKey[] | undefined;
  error?: errors.$ZodErrorMap | undefined;
  params?: Record<string, any> | undefined;
  fn: (arg: O) => unknown; // checks.$ZodCheck<O>["_zod"]["check"];
}

export interface $ZodCustomInternals<O = unknown, I = unknown>
  extends $ZodTypeInternals<O, I>,
    checks.$ZodCheckInternals<O> {
  def: $ZodCustomDef;
  issc: errors.$ZodIssue;
  isst: never;
}

export interface $ZodCustom<O = unknown, I = unknown> extends $ZodType {
  _zod: $ZodCustomInternals<O, I>;
}

export const $ZodCustom: core.$constructor<$ZodCustom> = /*@__PURE__*/ core.$constructor("$ZodCustom", (inst, def) => {
  if (def.checks?.length) console.warn("Can't add custom checks to z.custom()");

  checks.$ZodCheck.init(inst, def);
  $ZodType.init(inst, def);

  inst._zod.parse = (payload, _) => {
    return payload;
  };

  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input as any);
    if (r instanceof Promise) {
      return r.then((r) => handleRefineResult(r, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});

function handleRefineResult(result: unknown, payload: ParsePayload, input: unknown, inst: $ZodCustom): void {
  if (!result) {
    const _iss: any = {
      code: "custom",
      input,
      inst, // incorporates params.error into issue reporting
      path: inst._zod.def.path, // incorporates params.error into issue reporting
      continue: !inst._zod.def.abort,
      // params: inst._zod.def.params,
    };
    if (inst._zod.def.params) _iss.params = inst._zod.def.params;
    payload.issues.push(util.issue(_iss));
  }
}

export type $ZodTypes =
  | $ZodString
  | $ZodNumber
  | $ZodBigInt
  | $ZodBoolean
  | $ZodDate
  | $ZodSymbol
  | $ZodUndefined
  | $ZodNullable
  | $ZodNull
  | $ZodAny
  | $ZodUnknown
  | $ZodNever
  | $ZodVoid
  | $ZodArray
  | $ZodObject
  | $ZodInterface
  | $ZodUnion
  | $ZodIntersection
  | $ZodTuple
  | $ZodRecord
  | $ZodMap
  | $ZodSet
  | $ZodLiteral
  | $ZodEnum
  | $ZodPromise
  | $ZodLazy
  | $ZodOptional
  | $ZodDefault
  | $ZodTemplateLiteral
  | $ZodCustom
  | $ZodTransform
  | $ZodNonOptional
  | $ZodReadonly
  | $ZodNaN
  | $ZodPipe
  | $ZodSuccess
  | $ZodCatch
  | $ZodFile;
