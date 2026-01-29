export const tokenize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

export const jaccardSimilarity = (a: string, b: string) => {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 && tokensB.size === 0) {
    return 1;
  }
  const intersection = [...tokensA].filter((token) => tokensB.has(token));
  const union = new Set([...tokensA, ...tokensB]);
  return intersection.length / union.size;
};

export const isTooSimilar = (candidate: string, recent: string[], threshold = 0.8) =>
  recent.some((item) => jaccardSimilarity(candidate, item) >= threshold);

export const pickNextPost = (
  pool: string[],
  recent: string[],
  threshold = 0.8,
): { value: string; reason: string } => {
  for (const candidate of pool) {
    if (recent[0] === candidate) {
      continue;
    }
    if (isTooSimilar(candidate, recent, threshold)) {
      continue;
    }
    return { value: candidate, reason: "selected" };
  }
  return {
    value: pool[0] ?? "",
    reason: "fallback: no unique candidates under similarity threshold",
  };
};
