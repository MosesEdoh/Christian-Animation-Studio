import { Router, type IRouter } from "express";
import healthRouter from "./health";
import studioRouter from "./studio";
import authRouter from "./auth";
import storageRouter from "./storage";
import { requireStudioAccess } from "../middlewares/studioAccess";
import movieExportsRouter from "./movieExports";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use("/studio", requireStudioAccess);
router.use("/storage/uploads", requireStudioAccess);
router.use("/storage/objects", requireStudioAccess);
router.use(storageRouter);
router.use(studioRouter);
router.use(movieExportsRouter);

export default router;
