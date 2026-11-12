import { buildTradeNetworkFixture } from './helpers/trade-network-fixture.ts'

const fixture = await buildTradeNetworkFixture()
await fixture.context.app.listen({ port: 3103, host: '127.0.0.1' })
console.log('RESULT isolated trade network fixture ready')
