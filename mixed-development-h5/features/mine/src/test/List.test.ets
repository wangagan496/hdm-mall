import localUnitTest from './LocalUnit.test';
import moduleStructureTests from './ModuleStructure.test'

export default function testsuite() {
  moduleStructureTests()
  localUnitTest();
}
