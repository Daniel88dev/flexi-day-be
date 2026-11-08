export const USER_TEXT_KEY = "user_text";

export type UserText = { [USER_TEXT_KEY]: string };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** `requests[].note` → `[{ key: "requests", each: true }, { key: "note", each: false }]`. */
const parsePath = (path: string) =>
  path.split(".").map((segment) => {
    const each = segment.endsWith("[]");
    return { key: each ? segment.slice(0, -2) : segment, each };
  });

type Segment = ReturnType<typeof parsePath>[number];

const wrap = (value: Json): Json =>
  typeof value === "string" ? { [USER_TEXT_KEY]: value } : value;

const isObject = (value: Json): value is { [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const applyAt = (value: Json, segments: Segment[]): Json => {
  const [head, ...rest] = segments;
  if (!head) return wrap(value);

  const step = (child: Json): Json => {
    if (!head.each) return applyAt(child, rest);
    return Array.isArray(child) ? child.map((item) => applyAt(item, rest)) : child;
  };

  if (head.key === "") return step(value);
  if (!isObject(value) || !(head.key in value)) return value;
  return { ...value, [head.key]: step(value[head.key]!) };
};

/**
 * The result as a model may read it: plain JSON, with every string at a
 * declared path wrapped as `{"user_text": "…"}` so the model can tell text
 * people wrote from the data around it. Paths that miss are skipped; `null`
 * stays `null`.
 */
export const serializeToolResult = (result: unknown, userTextPaths: readonly string[]): Json => {
  let value = JSON.parse(JSON.stringify(result ?? null)) as Json;
  for (const path of userTextPaths) value = applyAt(value, parsePath(path));
  return value;
};

/** The reverse of the wrapping: every `{"user_text": "…"}` back to its plain string, for people to read. */
export const plainUserText = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(plainUserText);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value);
  if (
    entries.length === 1 &&
    entries[0]![0] === USER_TEXT_KEY &&
    typeof entries[0]![1] === "string"
  ) {
    return entries[0]![1];
  }
  return Object.fromEntries(entries.map(([key, child]) => [key, plainUserText(child)]));
};
