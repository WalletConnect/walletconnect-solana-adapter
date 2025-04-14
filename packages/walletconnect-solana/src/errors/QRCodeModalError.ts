export class QRCodeModalError extends Error {
  constructor() {
    super('QR Code Modal was closed by user')

    // Set the prototype explicitly.
    Object.setPrototypeOf(this, QRCodeModalError.prototype)
    this.name = 'QRCodeModalError'
  }
}
