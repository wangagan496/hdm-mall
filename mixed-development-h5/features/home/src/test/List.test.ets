import localUnitTest from './LocalUnit.test';
import skuSelectionTest from './SkuSelection.test';

export default function testsuite() {
  localUnitTest();
  skuSelectionTest();
}