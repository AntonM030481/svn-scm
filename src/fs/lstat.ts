import { promisify } from "node:util";
import { physicalFs } from "./physical";

export const lstat = promisify(physicalFs.lstat);
