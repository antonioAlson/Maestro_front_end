import jwt from 'jsonwebtoken';

// Like authenticate, but also accepts ?token=<jwt> query param.
// Use only for file-serving endpoints that need to work in browser <a> / <img> contexts.
export const authenticateFlexible = (req, res, next) => {
  try {
    let token = null;

    const authHeader = req.headers.authorization;
    if (authHeader && /^Bearer\s/i.test(authHeader)) {
      token = authHeader.split(' ')[1];
    } else if (req.query.token) {
      token = String(req.query.token);
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token de autenticação não fornecido',
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: 'Token inválido ou expirado',
    });
  }
};
