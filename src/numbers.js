// Kleine Rechenhilfen, die mehrere Module brauchen.

// Der Median, `null` ohne Werte. Bei gerader Anzahl die Mitte der beiden mittleren Werte, ungerundet.
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

module.exports = { median };
