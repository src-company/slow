/*
 * CreateX-guarded CREATE3 vanity miner.
 *
 * The JS derivation in scripts/address.mjs is correct and far too slow to mine
 * with — about 1,400 addresses a second, which puts a six-nibble prefix at
 * three hours and the eight the page already carries out of reach entirely.
 * This is the same derivation in C, and it does a few million a second.
 *
 * WHAT IS BEING DERIVED, and why it is not the obvious thing:
 *
 *   guarded = keccak256(bytes32(sender) ++ salt)          CreateX's _guard()
 *   proxy   = keccak256(0xff ++ CreateX ++ guarded ++ PROXY_INITCODE_HASH)[12:]
 *   child   = keccak256(0xd694 ++ proxy ++ 0x01)[12:]
 *
 * Three hashes per candidate, not one. `cast create2` cannot substitute: it
 * mines the CREATE2 address, which here is the throwaway proxy, and the address
 * anyone cares about is the child one CREATE further on.
 *
 * THE SALT SHAPE IS NOT FREE. Bytes 0..19 must be the sender, or CreateX guards
 * the salt differently and the result lands somewhere else. Byte 20 must be
 * 0x00, or block.chainid enters the guard and every chain gets a different
 * address. Only bytes 21..31 are searchable, which is 88 bits — ample.
 *
 * Verify against the JS before trusting a salt from this: `--check <salt>`
 * prints the derived address for a given salt, and scripts/address.mjs must
 * agree. A miner with the wrong derivation mines an address the deployer can
 * never reach.
 *
 *   cc -O3 -pthread -o /tmp/mine scripts/mine.c
 *   /tmp/mine <sender> <prefix-hex> [threads]
 *   /tmp/mine <sender> --check <salt32hex>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <pthread.h>

/* ── keccak-f[1600] ─────────────────────────────────────────────────────── */

static const uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL,
    0x8000000080008000ULL, 0x000000000000808bULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL,
    0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
    0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL,
    0x000000000000800aULL, 0x800000008000000aULL, 0x8000000080008081ULL,
    0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL};
static const int RHO[24] = {1,  3,  6,  10, 15, 21, 28, 36, 45, 55, 2,  14,
                            27, 41, 56, 8,  25, 43, 62, 18, 39, 61, 20, 44};
static const int PI[24] = {10, 7,  11, 17, 18, 3, 5,  16, 8,  21, 24, 4,
                           15, 23, 19, 13, 12, 2, 20, 14, 22, 9,  6,  1};

#define ROL(x, n) (((x) << (n)) | ((x) >> (64 - (n))))

static void keccakf(uint64_t s[25]) {
    for (int r = 0; r < 24; r++) {
        uint64_t bc[5], t;
        for (int i = 0; i < 5; i++)
            bc[i] = s[i] ^ s[i + 5] ^ s[i + 10] ^ s[i + 15] ^ s[i + 20];
        for (int i = 0; i < 5; i++) {
            t = bc[(i + 4) % 5] ^ ROL(bc[(i + 1) % 5], 1);
            for (int j = 0; j < 25; j += 5) s[j + i] ^= t;
        }
        t = s[1];
        for (int i = 0; i < 24; i++) {
            int j = PI[i];
            uint64_t tmp = s[j];
            s[j] = ROL(t, RHO[i]);
            t = tmp;
        }
        for (int j = 0; j < 25; j += 5) {
            for (int i = 0; i < 5; i++) bc[i] = s[j + i];
            for (int i = 0; i < 5; i++)
                s[j + i] = bc[i] ^ ((~bc[(i + 1) % 5]) & bc[(i + 2) % 5]);
        }
        s[0] ^= RC[r];
    }
}

/* keccak256 over a buffer shorter than the 136-byte rate: one permutation. */
static void keccak256(const uint8_t *in, size_t len, uint8_t out[32]) {
    uint64_t s[25];
    uint8_t buf[136];
    memset(s, 0, sizeof(s));
    memset(buf, 0, sizeof(buf));
    memcpy(buf, in, len);
    buf[len] = 0x01;         /* keccak padding, NOT SHA3's 0x06 */
    buf[135] |= 0x80;
    for (int i = 0; i < 17; i++) {
        uint64_t w = 0;
        for (int b = 7; b >= 0; b--) w = (w << 8) | buf[i * 8 + b];
        s[i] ^= w;
    }
    keccakf(s);
    for (int i = 0; i < 4; i++)
        for (int b = 0; b < 8; b++) out[i * 8 + b] = (uint8_t)(s[i] >> (8 * b));
}

/* ── the derivation ─────────────────────────────────────────────────────── */

static const uint8_t CREATEX[20] = {0xba, 0x5E, 0xd0, 0x99, 0x63, 0x3D, 0x3B,
                                    0x31, 0x3e, 0x4D, 0x5F, 0x7b, 0xdc, 0x13,
                                    0x05, 0xd3, 0xc2, 0x8b, 0xa5, 0xEd};
/* keccak256(0x67363d3d37363d34f03d5260086018f3) */
static uint8_t PROXY_HASH[32];

static void proxy_hash_init(void) {
    const uint8_t code[16] = {0x67, 0x36, 0x3d, 0x3d, 0x37, 0x36, 0x3d, 0x34,
                              0xf0, 0x3d, 0x52, 0x60, 0x08, 0x60, 0x18, 0xf3};
    keccak256(code, 16, PROXY_HASH);
}

/* salt must be 32 bytes with bytes 0..19 == sender and byte 20 == 0. */
static void derive(const uint8_t sender[20], const uint8_t salt[32],
                   uint8_t out[20]) {
    uint8_t buf[85], h[32];

    /* guarded = keccak256(bytes32(sender) ++ salt) */
    memset(buf, 0, 12);
    memcpy(buf + 12, sender, 20);
    memcpy(buf + 32, salt, 32);
    keccak256(buf, 64, h);

    /* proxy = keccak256(0xff ++ CreateX ++ guarded ++ PROXY_HASH)[12:] */
    buf[0] = 0xff;
    memcpy(buf + 1, CREATEX, 20);
    memcpy(buf + 21, h, 32);
    memcpy(buf + 53, PROXY_HASH, 32);
    keccak256(buf, 85, h);

    /* child = keccak256(0xd6 0x94 ++ proxy ++ 0x01)[12:] */
    buf[0] = 0xd6;
    buf[1] = 0x94;
    memcpy(buf + 2, h + 12, 20);
    buf[22] = 0x01;
    keccak256(buf, 23, h);
    memcpy(out, h + 12, 20);
}

/* ── search ─────────────────────────────────────────────────────────────── */

static uint8_t g_sender[20];
static uint8_t g_prefix[20];
static int g_nibbles;
static volatile int g_found;
static uint8_t g_salt[32];
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static volatile uint64_t g_tried;

static int matches(const uint8_t a[20]) {
    for (int i = 0; i < g_nibbles / 2; i++)
        if (a[i] != g_prefix[i]) return 0;
    if (g_nibbles & 1) {
        int i = g_nibbles / 2;
        if ((a[i] >> 4) != (g_prefix[i] >> 4)) return 0;
    }
    return 1;
}

typedef struct { int id; int nthreads; } arg_t;

static void *worker(void *vp) {
    arg_t *a = (arg_t *)vp;
    uint8_t salt[32], addr[20];
    memset(salt, 0, 32);
    memcpy(salt, g_sender, 20);            /* bytes 0..19: sender  */
    salt[20] = 0x00;                       /* byte 20: flag clear  */
    uint64_t counter = (uint64_t)a->id;
    uint64_t local = 0;
    while (!g_found) {
        /* bytes 21..31 are searchable; use the low 8 as the counter. */
        for (int b = 0; b < 8; b++) salt[31 - b] = (uint8_t)(counter >> (8 * b));
        derive(g_sender, salt, addr);
        if (matches(addr)) {
            pthread_mutex_lock(&g_lock);
            if (!g_found) { memcpy(g_salt, salt, 32); g_found = 1; }
            pthread_mutex_unlock(&g_lock);
            break;
        }
        counter += (uint64_t)a->nthreads;
        if ((++local & 0xFFFFF) == 0) __sync_fetch_and_add(&g_tried, 0x100000);
    }
    return NULL;
}

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int parse_hex(const char *s, uint8_t *out, int maxbytes, int *nibbles) {
    if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) s += 2;
    int n = 0;
    memset(out, 0, maxbytes);
    for (const char *p = s; *p; p++) {
        int v = hexval(*p);
        if (v < 0) return -1;
        if (n / 2 >= maxbytes) return -1;
        if (n % 2 == 0) out[n / 2] = (uint8_t)(v << 4);
        else out[n / 2] |= (uint8_t)v;
        n++;
    }
    *nibbles = n;
    return 0;
}

static void print_hex(const uint8_t *b, int n) {
    printf("0x");
    for (int i = 0; i < n; i++) printf("%02x", b[i]);
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr,
                "usage: mine <sender> <prefix-hex> [threads]\n"
                "       mine <sender> --check <salt32hex>\n");
        return 2;
    }
    proxy_hash_init();

    int n;
    if (parse_hex(argv[1], g_sender, 20, &n) < 0 || n != 40) {
        fprintf(stderr, "sender must be 20 bytes\n");
        return 2;
    }

    if (strcmp(argv[2], "--check") == 0) {
        if (argc < 4) { fprintf(stderr, "--check needs a salt\n"); return 2; }
        uint8_t salt[32], addr[20];
        if (parse_hex(argv[3], salt, 32, &n) < 0 || n != 64) {
            fprintf(stderr, "salt must be 32 bytes\n");
            return 2;
        }
        derive(g_sender, salt, addr);
        print_hex(addr, 20);
        printf("\n");
        return 0;
    }

    if (parse_hex(argv[2], g_prefix, 20, &g_nibbles) < 0 || g_nibbles == 0) {
        fprintf(stderr, "bad prefix\n");
        return 2;
    }
    int threads = argc > 3 ? atoi(argv[3]) : 4;
    if (threads < 1) threads = 1;

    pthread_t *th = calloc((size_t)threads, sizeof(pthread_t));
    arg_t *args = calloc((size_t)threads, sizeof(arg_t));
    for (int i = 0; i < threads; i++) {
        args[i].id = i;
        args[i].nthreads = threads;
        pthread_create(&th[i], NULL, worker, &args[i]);
    }
    for (int i = 0; i < threads; i++) pthread_join(th[i], NULL);

    uint8_t addr[20];
    derive(g_sender, g_salt, addr);
    printf("salt    ");
    print_hex(g_salt, 32);
    printf("\naddress ");
    print_hex(addr, 20);
    printf("\ntried   %llu\n", (unsigned long long)g_tried);
    return 0;
}
