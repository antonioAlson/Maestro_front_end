import jwt from 'jsonwebtoken';

// Requires a valid step-up token in the X-Step-Up-Token header.
// The token is obtained via POST /auth/step-up (password confirmation).
// Expires in 5 minutes and is single-resource (tied to the user's id).
export function requireStepUp(req, res, next) {
  const token = req.headers['x-step-up-token'];

  if (!token) {
    return res.status(403).json({
      success: false,
      code: 'STEP_UP_REQUIRED',
      message: 'Reautenticação necessária para esta ação.',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.stepUp || decoded.id !== req.user?.id) {
      return res.status(403).json({
        success: false,
        code: 'STEP_UP_INVALID',
        message: 'Token de reautenticação inválido.',
      });
    }

    next();
  } catch {
    return res.status(403).json({
      success: false,
      code: 'STEP_UP_EXPIRED',
      message: 'Reautenticação expirada. Confirme a senha novamente.',
    });
  }
}
