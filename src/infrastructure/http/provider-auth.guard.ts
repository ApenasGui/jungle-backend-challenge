import { Injectable, type CanActivate } from '@nestjs/common';

// Ponto de extensão: substituir por validação OIDC/JWKS e autorização do provedor.
// O desafio usa acesso aberto; este guard não oferece autenticação.
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean { return true; }
}
