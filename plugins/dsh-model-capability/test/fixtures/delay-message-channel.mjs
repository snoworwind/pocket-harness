const Original = globalThis.MessageChannel
const probe = new Original()
let proto = probe.port1
let descriptor
while (proto && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(proto, 'onmessage'); proto = Object.getPrototypeOf(proto) }
probe.port1.close()
probe.port2.close()
globalThis.MessageChannel = class extends Original {
  constructor() {
    super()
    const port = this.port1
    Object.defineProperty(port, 'onmessage', { set(handler) {
      descriptor.set.call(port, event => setTimeout(() => handler(event), 180))
    } })
  }
}
