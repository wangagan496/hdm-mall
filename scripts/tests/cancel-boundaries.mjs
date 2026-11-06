import { execute, sourceOf } from './native-harness.mjs'
export const { cancelActionFailure } = execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/CancelActions.ets'))
export const emptyCancelActions = { pending: () => [], confirm: () => { throw new Error('unexpected cancel request') }, recover: () => { throw new Error('unexpected cancel recovery') } }
