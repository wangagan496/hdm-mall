import quoteVectorTests from './QuoteVectors.test'
import identityVectorTests from './IdentityVectors.test'
import promiseVectorTests from './PromiseVectors.test'
import sourceRecordVectorTests from './SourceRecordVectors.test'
import compensationVectorTests from './CompensationVectors.test'
export default function testsuite(): void {
  quoteVectorTests()
  identityVectorTests()
  promiseVectorTests()
  sourceRecordVectorTests()
  compensationVectorTests()
}
