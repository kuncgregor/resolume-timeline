// node-osc ships without type declarations; only the UDP client is used
declare module 'node-osc' {
  export class Client {
    constructor(host: string, port: number)
    send(address: string, ...args: unknown[]): void
    close(): void
  }
}
