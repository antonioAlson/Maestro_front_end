import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import jiraRoutes from './routes/jira.js';
import printRoutes from './routes/print.js';
import ordensDiariasRoutes from './routes/ordensDiarias.js';
import cuttingProjectsRoutes from './routes/cuttingPlans.js';
import filesRoutes from './routes/files.js';
import mirrorsRoutes from './routes/mirrors.js';
import auditRoutes from './routes/audit.js';
import qualityRoutes from './routes/quality.js';
import plateSuppliersRoutes from './routes/plateSuppliers.js';
import osPlanningRoutes from './routes/osPlanning.js';
import productionPacksRoutes from './routes/productionPacks.js';
import { ensureDatabaseCompatibility } from './config/database.js';

// Carregar variáveis de ambiente
dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Confiar no proxy reverso (nginx/Caddy) para X-Forwarded-Proto
app.set('trust proxy', 1);

// Middlewares
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  exposedHeaders: ['Content-Disposition', 'X-OS-Failures', 'X-OS-Field-Warnings']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log de requisições (desenvolvimento)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`, req.body);
    next();
  });
}

// Rota de health check
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Maestro API está rodando!',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Rotas da API
app.use('/api/auth', authRoutes);
app.use('/api/jira', jiraRoutes);
app.use('/api/print', printRoutes);
app.use('/api/ordens-diarias', ordensDiariasRoutes);
app.use('/api/cutting-projects', cuttingProjectsRoutes);
app.use('/api/files',            filesRoutes);
app.use('/api/mirrors',          mirrorsRoutes);
app.use('/api/audit',            auditRoutes);
app.use('/api/quality',          qualityRoutes);
app.use('/api/plate-suppliers',  plateSuppliersRoutes);
app.use('/api/os-planning',      osPlanningRoutes);
app.use('/api/production-packs', productionPacksRoutes);

// Rota 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Rota não encontrada'
  });
});

// Error handler global
app.use((err, req, res, next) => {
  console.error('Erro:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Erro interno do servidor',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Iniciar servidor com fallback de porta para desenvolvimento
function startServer(initialPort) {
  const server = app.listen(initialPort, () => {
    console.log('🚀 Servidor rodando na porta:', initialPort);
    console.log(`📡 API disponível em: http://localhost:${initialPort}`);
    console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = initialPort + 1;
      console.error(`⚠️ Porta ${initialPort} em uso. Tentando porta ${nextPort}...`);
      startServer(nextPort);
      return;
    }

    console.error('❌ Erro ao iniciar servidor:', err);
    process.exit(1);
  });
}

async function bootstrap() {
  try {
    await ensureDatabaseCompatibility();
    startServer(PORT);
  } catch (error) {
    console.error('❌ Erro ao validar estrutura do banco:', error);
    process.exit(1);
  }
}

bootstrap();

// Tratamento de erros não capturados
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

//Carrega a automação de atualização dos cards no banco
import "./cron_jobs/sync_cards_jira.cjs";
import "./cron_jobs/update_comtec_cards.cjs";
