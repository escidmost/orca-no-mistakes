// Disposable ONM-100 CI drill fixture; see acceptance/onm100-live/README.md.
export function total(unitPrice, quantity) {
  return unitPrice * quantity;
}

console.log(total(2, 3));
