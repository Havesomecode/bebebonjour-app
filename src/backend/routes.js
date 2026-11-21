import { intakePage, intakeSubmit, checkoutSubmit, reviewPage, reviewSubmit, announcement, operatorPage, operatorSubmit } from './deliveryLoopHttp.js';
import { dataControl, dataExport, dataOperatorPage, dataOperatorControl } from './deliveryLoopDataHttp.js';
import { paidPaymentWebhook } from './deliveryLoopPaymentHttp.js';
import { termsPage } from './deliveryLoopTerms.js';
const routes = new Map(Object.entries({
  'GET /delivery':intakePage, 'POST /delivery/intake':intakeSubmit, 'POST /delivery/checkout':checkoutSubmit,
  'GET /delivery/review':reviewPage, 'POST /delivery/review':reviewSubmit,
  'GET /delivery/operator':operatorPage, 'POST /delivery/operator':operatorSubmit,
  'POST /delivery/data':dataControl, 'GET /delivery/export':dataExport,
  'GET /delivery/data/operator':dataOperatorPage, 'POST /delivery/data/operator':dataOperatorControl,
  'GET /delivery/terms/route-a-39-v2':termsPage, 'POST /delivery/payment/webhook':paidPaymentWebhook,
}));
export default { lookup(path, method) { const handler=routes.get(`${method} ${path}`) || (method === 'GET' && path.startsWith('/announcements/') ? announcement : null); return handler ? [handler] : null; } };
