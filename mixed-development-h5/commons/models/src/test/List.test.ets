import quoteVectorTests from './QuoteVectors.test'
import identityVectorTests from './IdentityVectors.test'
export default function testsuite(): void {
  quoteVectorTests()
  identityVectorTests()
}
