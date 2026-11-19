import quoteVectorTests from './QuoteVectors.test'
import identityVectorTests from './IdentityVectors.test'
import promiseVectorTests from './PromiseVectors.test'
export default function testsuite(): void {
  quoteVectorTests()
  identityVectorTests()
  promiseVectorTests()
}
