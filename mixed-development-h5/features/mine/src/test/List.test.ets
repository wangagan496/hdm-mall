import localUnitTest from './LocalUnit.test';
import moduleStructureTests from './ModuleStructure.test'
import protectionTests from './Protection.test'
import spendingSettingTest from './SpendingSetting.test'

export default function testsuite() {
  moduleStructureTests()
  localUnitTest();
  protectionTests()
  spendingSettingTest()
}
