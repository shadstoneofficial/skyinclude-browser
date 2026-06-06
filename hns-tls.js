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

function inspectHnsHttpsCertificate({ domain, address, port = 443, timeout = 10000, tlsModule = tls }) {
    return new Promise(resolve => {
        let settled = false;
        const finish = result => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(result);
        };

        const socket = tlsModule.connect({
            host: address,
            port,
            servername: domain,
            rejectUnauthorized: false
        }, () => {
            const certificate = socket.getPeerCertificate(true);
            if (!certificate || Object.keys(certificate).length === 0) {
                socket.end();
                finish({
                    ok: false,
                    state: 'connection_failure',
                    error: 'No peer certificate was presented'
                });
                return;
            }

            const publicKeyDer = getPublicKeyDer(certificate);
            socket.end();
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
        });

        socket.once('error', error => {
            finish({
                ok: false,
                state: 'connection_failure',
                error: error.message
            });
        });

        socket.setTimeout(timeout, () => {
            socket.destroy(new Error('TLS connection timeout'));
            finish({
                ok: false,
                state: 'connection_failure',
                error: 'TLS connection timeout'
            });
        });
    });
}

module.exports = {
    inspectHnsHttpsCertificate
};
