// The middle of the signature: the last base64url character also carries padding bits.
export const tamper = (state: string): string => {
  const at = state.length - 10;
  return `${state.slice(0, at)}${state[at] === "A" ? "B" : "A"}${state.slice(at + 1)}`;
};
