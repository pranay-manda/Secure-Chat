import { Router } from 'express';

/**
 * The caller's own account. Authentication (a live session on an active device) is required;
 * the account to act on always comes from that session, never from the request.
 */
export function createAccountRouter({ accountService, rateLimiters, authenticate }) {
  const router = Router();

  router.use(authenticate, rateLimiters.byUser('authenticatedPerUser'));

  // Permanently deletes the account and signs it out everywhere.
  router.delete('/', async (req, res) => {
    await accountService.deleteAccount(req.auth);
    res.status(204).end();
  });

  return router;
}
