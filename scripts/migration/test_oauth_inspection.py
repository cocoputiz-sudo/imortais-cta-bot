import json
import unittest
from unittest.mock import patch

import inspect_oauth as oauth


class OAuthInspection(unittest.TestCase):
    def test_exact_registration_and_no_secrets_in_report(self):
        result=oauth.application_report({"id":oauth.production.APP_ID,"name":"IMORTAIS",
            "redirect_uris":[oauth.production.CALLBACK,oauth.CALLBACK,"https://user:private-password@example.org/callback?token=private-query#private-fragment"],
            "client_secret":"private-app-secret","owner":{"email":"private-email"}})
        self.assertTrue(result["old_callback_registered"] and result["new_callback_registered"])
        for secret in ("private-password","private-query","private-fragment","private-app-secret","private-email"):
            self.assertNotIn(secret,json.dumps(result))

    def test_optional_list_does_not_mean_no_callback_registered(self):
        result=oauth.application_report({"id":oauth.production.APP_ID})
        self.assertFalse(result["redirect_list_available"])
        self.assertIsNone(result["new_callback_registered"])
        for value in ({"id":"1560656423107432548"},{"id":oauth.production.APP_ID,"redirect_uris":"hidden"}):
            with self.assertRaises(ValueError):
                oauth.application_report(value)

    def test_host_probe_failure_does_not_claim_external_outage(self):
        calls=[]
        def fetch(url,token=None):
            calls.append((url,token))
            if url==oauth.APPLICATION:
                return {"id":oauth.production.APP_ID,"redirect_uris":[oauth.production.CALLBACK]}
            raise RuntimeError("Network unavailable")
        result=oauth.inspect("synthetic-secret",fetch)
        self.assertFalse(result["new_callback_registered"])
        self.assertEqual(result["https_from_debian"]["external_client_status"],"unknown")
        self.assertEqual(calls,[(oauth.APPLICATION,"synthetic-secret"),(oauth.HEALTH,None)])
        self.assertNotIn("synthetic-secret",json.dumps(result))
        self.assertFalse(result["gateway_connected"] or result["discord_configuration_changed"])

    def test_fixed_get_only_requests_and_no_auth_to_domain(self):
        class Response:
            status=200
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,size):return b'{"mode":"migration-hold"}'
        class Opener:
            def open(self,request,timeout):
                self.request=request
                return Response()
        opener=Opener()
        with patch.object(oauth.urllib.request,"build_opener",return_value=opener):
            oauth.request_json(oauth.APPLICATION,"synthetic-secret")
            self.assertEqual(opener.request.get_method(),"GET")
            self.assertEqual(opener.request.get_header("Authorization"),"Bot synthetic-secret")
            oauth.request_json(oauth.HEALTH)
            self.assertIsNone(opener.request.get_header("Authorization"))
        for url,token in (("https://example.com",None),(oauth.HEALTH,"synthetic-secret")):
            with self.assertRaises(ValueError):oauth.request_json(url,token)
        self.assertIsNone(oauth.NoRedirect().redirect_request(None,None,None,None,None,None))


if __name__=="__main__":unittest.main()
