const tls = require('tls');
const crypto = require('crypto');

function getPublicKeyDer(certificate) {
    if (!certificate?.raw) {
        return null;
    }

    try {
        const x509 = new crypto.X509Certificate(certificate.raw);
        return x509.publicKey.export({ type: 'spki', format: 'der' });
    } catch (error) {
        return null;
    }
}

function inspectHnsHttpsCertificate({ domain, address, port = 443, timeout = 10000, signal, tlsModule = tls }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let socket;
        let deadline;
        const finish = (result, error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(deadline);
            signal?.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve(result);
        };
        const abort = () => {
            const error = new Error('TLS certificate probe aborted');
            error.name = 'AbortError';
            finish(null, error);
            socket?.destroy();
        };
        if (signal?.aborted) {
            abort();
            return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        // This covers TCP establishment and the entire TLS handshake. Socket
        // inactivity timeouts alone can be extended by a trickling peer.
        const duration = Number.isFinite(timeout) && timeout > 0 ? timeout : 10000;
        deadline = setTimeout(() => {
            finish({ ok: false, state: 'connection_failure', error: 'TLS connection timeout' });
            socket?.destroy();
        }, duration);

        try {
            socket = tlsModule.connect({
                host: address,
                port,
                servername: domain,
                rejectUnauthorized: false
            }, () => {
                if (settled) {
                    socket.destroy();
                    return;
                }
                const certificate = socket.getPeerCertificate(true);
                if (!certificate || Object.keys(certificate).length === 0) {
                    finish({
                        ok: false,
                        state: 'connection_failure',
                        error: 'No peer certificate was presented'
                    });
                    socket.destroy();
                    return;
                }

                const publicKeyDer = getPublicKeyDer(certificate);
                finish({
                    ok: true,
                    domain,
                    address,
                    port,
                    certificate: {
                        ...certificate,
                        publicKeyDer
                    }
                });
                // The probe sends no application data and must not linger waiting
                // for the peer to complete a graceful shutdown.
                socket.destroy();
            });

            socket.once('error', error => {
                finish({
                    ok: false,
                    state: 'connection_failure',
                    error: error.message
                });
            });
            socket.once('close', () => {
                finish({ ok: false, state: 'connection_failure', error: 'TLS connection closed before presenting a certificate' });
            });
        } catch (error) {
            finish({ ok: false, state: 'connection_failure', error: error.message });
            socket?.destroy();
        }
    });
}

module.exports = {
    inspectHnsHttpsCertificate
};
