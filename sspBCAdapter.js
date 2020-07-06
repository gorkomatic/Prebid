import * as utils from '../src/utils.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { BANNER, NATIVE } from '../src/mediaTypes.js';

const BIDDER_CODE = 'sspBC';
const BIDDER_URL = 'https://ssp.wp.pl/bidder/';
const SYNC_URL = 'https://ssp.wp.pl/bidder/usersync';
const TMAX = 450;
const BIDDER_VERSION = '4.0';

const cookieSupport = () => {
  const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
  const useCookies = window.navigator.cookieEnabled || !!document.cookie.length;
  return !isSafari && useCookies;
};

const getDevice = () => {
  return {
    ua: navigator.userAgent,
    language: (navigator.language || navigator.browserLanguage || navigator.userLanguage || navigator.systemLanguage),
  };
};

const applyClientHints = (ortbRequest) => {
  const connection = navigator.connection || false;
  const viewport = window.visualViewport || false;
  const segments = [];
  const hints = {
    'CH-Ect': connection.effectiveType,
    'CH-Rtt': connection.rtt,
    'CH-SaveData': connection.saveData,
    'CH-Downlink': connection.downlink,
    'CH-DeviceMemory': navigator.deviceMemory,
    'CH-Dpr': window.devicePixelRatio,
    'CH-ViewportWidth': viewport.width,
  }
  Object.keys(hints).forEach(key => {
    const hint = hints[key];
    if (hint) {
      segments.push({
        'name': key,
        'value': hint.toString(),
      });
    }
  });
  const data = [
    {
      'id': '12',
      'name': 'NetInfo',
      'segment': segments,
    }]
  ortbRequest.user = Object.assign(ortbRequest.user, { 'data': data })
}

function applyGdpr(bidderRequest, ortbRequest) {
  if (bidderRequest && bidderRequest.gdprConsent) {
    ortbRequest.regs = Object.assign(ortbRequest.regs, { '[ortb_extensions.gdpr]': bidderRequest.gdprConsent.gdprApplies ? 1 : 0 });
    ortbRequest.user = Object.assign(ortbRequest.user, { '[ortb_extensions.consent]': bidderRequest.gdprConsent.consentString });
  }
}

export const spec = {
  code: BIDDER_CODE,
  aliases: [],
  supportedMediaTypes: [BANNER, NATIVE],
  isBidRequestValid: function(bid) {
    if (bid.params && bid.params.id) {
      return true;
    } else {
      return false;
    }
  },
  buildRequests: function(validBidRequests, bidderRequest) {
    if ((!validBidRequests) || (validBidRequests.length < 1)) {
      return false;
    }

    const siteId = setOnAny(validBidRequests, 'params.siteId');
    const page = setOnAny(validBidRequests, 'params.page') || bidderRequest.refererInfo.referer;
    const domain = setOnAny(validBidRequests, 'params.domain') || utils.parseUrl(page).hostname;
    const tmax = setOnAny(validBidRequests, 'params.tmax') ? parseInt(setOnAny(validBidRequests, 'params.tmax'), 10) : TMAX;
    const pbver = '$prebid.version$';
    let ref;
    try {
      if (window.self === window.top && document.referrer) { ref = document.referrer };
    } catch (e) {
    }

    const payload = {
      id: bidderRequest.auctionId,
      site: {id: siteId, page, domain, ref},
      imp: validBidRequests.map(slot => mapImpression(slot)),
      tmax,
      device: getDevice(),
      user: {},
      regs: {}
    };

    applyGdpr(bidderRequest, payload);
    applyClientHints(payload);

    return {
      method: 'POST',
      url: BIDDER_URL + '?cs=' + cookieSupport() + '&bdver=' + BIDDER_VERSION + '&pbver=' + pbver + 'inver=0',
      data: JSON.stringify(payload),
      bidderRequest: bidderRequest
    };
  },

  interpretResponse: function(serverResponse, request) {
    let response = serverResponse.body;
    let bids = [];
    let seat;
    if (response.seatbid !== undefined) {
      response.seatbid.forEach(seatbid => {
        seat = seatbid.seat;
        seatbid.bid.forEach(serverBid => {
          let bidRequest = request.bidderRequest.bids.filter(b => b.params.id === serverBid.impid)[0];
          if (bidRequest) {
            let bidFloor = bidRequest.params.bidFloor || 0;
            let bidCpm = bidRequest.params.flatCpm;
            if (!serverBid.gam && bidRequest.params.gam) {
              // build GAM config
              serverBid.gam = JSON.stringify({
                placement: bidRequest.params.gam,
                multiplier: 1,
                floor: bidRequest.params.gamFloor,
                ceil: 100,
                namedSizes: ['fluid'],
                div: 'div-gpt-ad-x01',
                targeting: {
                  OAS_retarg: '0',
                  PREBID_ON: '1',
                  DFPHASH: '',
                  emptygaf: '0'
                }
              });
            }
            let bid = {
              requestId: bidRequest.bidId,
              creativeId: 'bc' + Math.floor(1E10 * Math.random()),
              cpm: bidCpm || serverBid.price,
              currency: response.cur,
              ttl: serverBid.exp || 300,
              width: serverBid.w,
              height: serverBid.h,
              bidderCode: BIDDER_CODE,
              mediaType: 'banner',
              netRevenue: true,
              ad: renderCreative(bidRequest.params.siteId, response.id, serverBid, seat, request.bidderRequest)
            };
            if (bid.cpm > 0) {
              if (bid.cpm >= bidFloor) {
                bids.push(bid);
              } else {
                utils.logWarn('Discarding bid due to bidFloor setting', bid.cpm, bidFloor);
              }
            }
          } else {
            utils.logWarn('Discarding response - no matching request', serverBid.impid);
          }
        });
      });
    }
    return bids;
  },
  getUserSyncs: function(syncOptions, serverResponses) {
    if (syncOptions.iframeEnabled) {
      return [{
        type: 'iframe',
        url: SYNC_URL
      }];
    } else {
      utils.logWarn('sspBC adapter requires iframe based user sync.');
    }
  },
  onTimeout: function(timeoutData) {
  }
};
registerBidder(spec);

function setOnAny(collection, key) {
  for (let i = 0, result; i < collection.length; i++) {
    result = utils.deepAccess(collection[i], key);
    if (result) {
      return result;
    }
  }
}

function mapImpression(slot) {
  const imp = {
    id: slot.params.id,
    banner: mapBanner(slot),
    /* native: mapNative(slot), */
    tagid: slot.params.id
  };

  const bidfloor = parseFloat(slot.params.bidfloor);
  if (bidfloor) {
    imp.bidfloor = bidfloor
  }

  return imp;
}

/**
 * @param {object} slot Ad Unit Params by Prebid
 * @returns {object} Banner by OpenRTB 2.5 §3.2.6
 */
function mapBanner(slot) {
  if (slot.mediaType === 'banner' ||
    utils.deepAccess(slot, 'mediaTypes.banner') ||
    (!slot.mediaType && !slot.mediaTypes)) {
    let format = slot.sizes.map(size => ({
      w: size[0],
      h: size[1]
    }));
    // override - tylko 1szy wymiar
    // format = format.slice(0, 1);
    return {
      format,
      id: slot.bidId,
    };
  }
}
function renderCreative(siteId, auctionId, bid, seat, request) {
  let gam;
  let mcad = {
    'id': auctionId,
    'seat': seat,
    'seatbid': [{
      'bid': [bid]
    }]
  };
  let mcbase = btoa(encodeURI(JSON.stringify(mcad)));

  if (bid.adm) {
    // parse adm for gam config
    try {
      gam = JSON.parse(bid.adm).gam;
      if (!gam || !Object.keys(gam).length) {
        gam = undefined;
      } else {
        gam.namedSizes = ['fluid'];
        gam.div = 'div-gpt-ad-x01';
        gam.targeting = Object.assign(gam.targeting || {}, {
          OAS_retarg: '0',
          PREBID_ON: '1',
          emptygaf: '0'
        });
      }
      if (gam && !gam.targeting) {
        gam.targeting = {};
      }
    } catch (err) {
      utils.logWarn('Could not parse adm data', bid.adm);
    }
  }

  let adcode = `<head>
  <title></title>
  <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
    body {
    background-color: transparent;
    margin: 0;
    padding: 0;
  }
</style>
  <script>
  window.rekid = ${siteId};
  window.wp_sn = "mc_adapter";
  window.mcad = JSON.parse(decodeURI(atob("${mcbase}")));
  window.gdpr = ${JSON.stringify(request.gdprConsent)};
  `;
  if (gam) { adcode += `window.gam = ${JSON.stringify(gam)};`; }
  adcode += `</script>
    </head>
    <body>
    <div id="c"></div>
    <script id="wpjslib" crossorigin src="//std.wpcdn.pl/wpjslib/wpjslib-inline.js" async defer></script>
  </body>
  </html>`;

  return adcode;
}
