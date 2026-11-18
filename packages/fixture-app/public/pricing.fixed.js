// Cart pricing helpers (corrected variant served when the fixture's `fixed` flag is on).

export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

export function formatPrice(value) {
  if (Number.isNaN(value)) {
    console.warn('NaN passed to formatPrice');
    return '$0';
  }
  return `$${value}`;
}
