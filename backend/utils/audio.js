export function toBase64(input) {
  return Buffer.from(input).toString('base64');
}

export function fromBase64(base64) {
  return Buffer.from(base64, 'base64');
}
