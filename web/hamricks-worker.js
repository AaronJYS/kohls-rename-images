import { readHamricksWorkbook } from "./hamricks-reader.js";

self.onmessage = ({ data }) => {
  try { self.postMessage({ workbook: readHamricksWorkbook(data) }); }
  catch (error) { self.postMessage({ error: error.message || "The workbook could not be read." }); }
};
