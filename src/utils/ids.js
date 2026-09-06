import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const generate = customAlphabet(alphabet, 6);

export function generateEnvironmentId() {
  return `env-${generate()}`;
}

export function generateJobId() {
  return `job-${generate()}`;
}
