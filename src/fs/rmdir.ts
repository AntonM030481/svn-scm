import { promisify } from "node:util";
import { physicalFs } from "./physical";

export const rmdir = promisify(physicalFs.rmdir);
