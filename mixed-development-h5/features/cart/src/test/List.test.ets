import localUnitTest from './LocalUnit.test';
import invoiceTest from './Invoice.test';
import orderTabLoaderTest from './OrderTabLoader.test';
import evaluationSubmitFlowTest from './EvaluationSubmitFlow.test';
import evaluationNavigationTest from './EvaluationNavigation.test';

export default function testsuite() {
  localUnitTest();
  invoiceTest();
  orderTabLoaderTest();
  evaluationSubmitFlowTest();
  evaluationNavigationTest();
}
