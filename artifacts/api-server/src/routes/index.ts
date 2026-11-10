import { Router, type IRouter } from "express";
import healthRouter from "./health";
import studioRouter from "./studio";
import storageRouter from "./storage";
import { requireStudioAccess } from "../middlewares/studioAccess";
import movieExportsRouter from "./movieExports";
import childProfilesRouter from "./childProfiles";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/studio", requireStudioAccess);
router.use("/storage/uploads", requireStudioAccess);
router.use("/storage/objects", requireStudioAccess);
router.use(storageRouter);
router.use(studioRouter);
router.use(movieExportsRouter);
router.use(childProfilesRouter);

export default router;
