import { promisify } from "node:util";
import { physicalFs } from "./physical";

export const unlink = promisify(physicalFs.unlink);
