import { RequestAxios } from 'network'
import { GlobalVariable } from 'constants'

interface FixtureForm { fixture: string; password: string }
// Enabled only by an explicit Want on a debuggable build and a loopback test backend.
export async function deviceFixturePassword(account: string): Promise<string> {
  if (AppStorage.get<boolean>('debugFixtureForm') !== true || !/^device_(buyer|friend|merchant)$/.test(account) ||
    !/^http:\/\/127\.0\.0\.1(?::\d+)?\/?$/.test(GlobalVariable.BASE_URL)) return ''
  try {
    const form = await RequestAxios.getWithoutToast<FixtureForm>('/device-fixture/form/' + account)
    return form.fixture === 'device-trade-form' ? form.password : ''
  } catch { return '' }
}
