// Small arithmetic helpers several modules need.

// The median, `null` without values. With an even count, the middle of the two middle values, unrounded.
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

module.exports = { median };
