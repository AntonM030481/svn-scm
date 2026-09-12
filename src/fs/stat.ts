import { promisify } from "node:util";
import { physicalFs } from "./physical";

export const stat = promisify(physicalFs.stat);
