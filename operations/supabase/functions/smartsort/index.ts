// All imports use the same authenticated processing path.
import {handle} from '../ops-api/index.ts';
Deno.serve(handle);
