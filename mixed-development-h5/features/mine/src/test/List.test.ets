import localUnitTest from './LocalUnit.test';
import moduleStructureTests from './ModuleStructure.test'
import protectionTests from './Protection.test'

export default function testsuite() {
  moduleStructureTests()
  localUnitTest();
  protectionTests()
}
