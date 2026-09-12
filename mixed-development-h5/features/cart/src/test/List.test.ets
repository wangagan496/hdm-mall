import localUnitTest from './LocalUnit.test';
import orderTabLoaderTest from './OrderTabLoader.test';

export default function testsuite() {
  localUnitTest();
  orderTabLoaderTest();
}
