// Sends the old and alternate hostnames to https://everyapp.com, keeping the
// path and query string, with a permanent redirect so search engines move
// their index over.
const CANONICAL_ORIGIN = "https://everyapp.com";

export default {
  fetch(request: Request): Response {
    const { pathname, search } = new URL(request.url);
    return Response.redirect(`${CANONICAL_ORIGIN}${pathname}${search}`, 301);
  },
};
