import { buildSnapshots } from "./pglite";

export default async function setup() {
  await buildSnapshots();
}
