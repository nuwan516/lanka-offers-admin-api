import { Router, Request, Response } from 'express';
import { geoRepository } from '@/infrastructure/repositories/geo.repository';

const router = Router();

router.get('/geo/nearby', async (req: Request, res: Response) => {
  const { lat, lng, radius, bank, category, search, limit, offset } = req.query as Record<string, string | undefined>;

  const latNum = lat ? parseFloat(lat) : NaN;
  const lngNum = lng ? parseFloat(lng) : NaN;

  if (isNaN(latNum) || isNaN(lngNum) || latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
    res.status(400).json({ error: 'Valid lat (-90 to 90) and lng (-180 to 180) query parameters are required' });
    return;
  }

  const result = await geoRepository.findNearbyOffers({
    lat: latNum,
    lng: lngNum,
    radiusKm: radius ? parseFloat(radius) : undefined,
    bank,
    category,
    search,
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });

  res.json(result);
});

router.get('/geo/stats', async (_req: Request, res: Response) => {
  const stats = await geoRepository.getGeoStats();
  res.json(stats);
});

router.post('/geo/backfill', async (_req: Request, res: Response) => {
  const backfilledCount = await geoRepository.backfillGeometries();
  res.json({ message: 'PostGIS geometry backfill completed', count: backfilledCount });
});

export const geoRoutes = router;
