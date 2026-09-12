import { promisify } from "node:util";
import { physicalFs } from "./physical";

export const readdir = promisify(physicalFs.readdir);
