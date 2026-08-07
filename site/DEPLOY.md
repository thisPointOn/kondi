# Deploying the Kondi site to an apex domain (GoDaddy + AWS Lightsail)

The site is a single self-contained file: `index.html` (CSS, screenshots, and
the hash router are all inlined — nothing external to fetch). Host it anywhere
that serves a static file. These steps cover the fast path for an **apex domain
whose DNS lives at GoDaddy**, served from a **Lightsail instance**.

Why this path: GoDaddy DNS can only put an **A record (an IP)** at the apex
(`@`) — no ALIAS/ANAME, no CNAME flattening — so the apex must point at a fixed
IP. A Lightsail instance with a **static IP** gives you that. (S3/CloudFront or
a Lightsail bucket hand you a *hostname*, not an IP, so an apex on GoDaddy would
require moving your nameservers to Route 53 first.)

## 0. Prerequisites
- A Lightsail **instance** running nginx (you can share the one hosting wayside).
- A **static IP** attached to it (Lightsail console → Networking → attach static IP).
  Call it `STATIC_IP` below.

## 1. Put the file on the server
From this repo:
```bash
./site/deploy.sh ubuntu@STATIC_IP      # Ubuntu image
# or:  ./site/deploy.sh bitnami@STATIC_IP   (Bitnami image)
```
This copies `index.html` to `/var/www/kondi/index.html`.

## 2. Add the nginx server block
Copy `site/nginx-kondi.conf` to the server, replace `YOURDOMAIN`, enable it:
```bash
scp site/nginx-kondi.conf ubuntu@STATIC_IP:/tmp/
ssh ubuntu@STATIC_IP
  sudo sed -i 's/YOURDOMAIN/example.com/g' /tmp/nginx-kondi.conf
  sudo mv /tmp/nginx-kondi.conf /etc/nginx/sites-available/kondi
  sudo ln -sf /etc/nginx/sites-available/kondi /etc/nginx/sites-enabled/kondi
  sudo nginx -t && sudo systemctl reload nginx
```
> Bitnami images keep nginx under `/opt/bitnami/nginx/conf/server_blocks/` instead
> — drop the file there and `sudo /opt/bitnami/ctlscript.sh restart nginx`.

## 3. Point the domain at the instance (GoDaddy DNS)
In GoDaddy → your domain → **DNS → Manage Zones**, set:

| Type  | Name | Value        | TTL     |
|-------|------|--------------|---------|
| A     | `@`  | `STATIC_IP`  | 600     |
| CNAME | `www`| `@`          | 1 Hour  |

Delete any stray parked/forwarding `A`/`CNAME` on `@` or `www` first. DNS
propagation is usually minutes; up to an hour.

## 4. HTTPS (free, auto-renewing)
Once the A record resolves (`dig +short example.com` shows `STATIC_IP`):
```bash
ssh ubuntu@STATIC_IP
  sudo apt-get install -y certbot python3-certbot-nginx   # if not present
  sudo certbot --nginx -d example.com -d www.example.com
```
certbot rewrites the server block to serve 443 and redirect HTTP→HTTPS, and sets
up auto-renewal. Done — `https://example.com` now serves the site.

## Redeploying after a site change
Just re-run `./site/deploy.sh ubuntu@STATIC_IP` — it overwrites `index.html`.
No nginx/DNS changes needed.

## Optional upgrade: global CDN
If you later want edge caching/HTTPS via CloudFront while keeping the apex:
move the domain's **nameservers** to Route 53 (registration stays at GoDaddy),
create an S3 bucket + CloudFront distribution, and use a Route 53 **ALIAS**
record at the apex → the CloudFront domain. Not needed for a single small file.
