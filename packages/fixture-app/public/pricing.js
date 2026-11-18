// Cart pricing helpers.

export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function formatPrice(value) {
  if (Number.isNaN(value)) {
    console.warn('NaN passed to formatPrice');
    return '$0';
  }
  return `$${value}`;
}
