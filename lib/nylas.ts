import Nylas from "nylas";

const nylas = new Nylas({
  apiKey: process.env.NYLAS_API_KEY!,
});

export const GRANT_ID = process.env.NYLAS_GRANT_ID!;

export default nylas;
