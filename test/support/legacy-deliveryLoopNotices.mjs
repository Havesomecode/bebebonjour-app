import { bridge } from './legacy-functions.mjs';
import * as source from '../../src/backend/deliveryLoopNotices.js';
export const send = bridge(source.send);
