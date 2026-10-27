--
-- PostgreSQL database dump
--

\restrict 5rKTrZkbntq7JQmqjYkTTrEBKL3RFjudOnX52ytN0kr9J9aVUr4cI5jmrty1Wg7

-- Dumped from database version 17.11 (Debian 17.11-1.pgdg13+2)
-- Dumped by pg_dump version 17.11 (Debian 17.11-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: app; Type: SCHEMA; Schema: -; Owner: app_owner
--

CREATE SCHEMA app;


ALTER SCHEMA app OWNER TO app_owner;

--
-- Name: mood; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.mood AS ENUM (
    'a',
    'b'
);


ALTER TYPE public.mood OWNER TO postgres;

--
-- Name: f(integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.f(integer) RETURNS integer
    LANGUAGE sql
    AS $_$select $1 + 1$_$;


ALTER FUNCTION public.f(integer) OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: users; Type: TABLE; Schema: public; Owner: app_owner
--

CREATE TABLE public.users (
    id integer NOT NULL,
    email text NOT NULL,
    m public.mood
);


ALTER TABLE public.users OWNER TO app_owner;

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: app_owner
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.users_id_seq OWNER TO app_owner;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: app_owner
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: v; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v AS
 SELECT id,
    email
   FROM public.users;


ALTER VIEW public.v OWNER TO postgres;

--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: app_owner
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: app_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users p; Type: POLICY; Schema: public; Owner: app_owner
--

CREATE POLICY p ON public.users TO "Readers" USING (true);


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: app_owner
--

GRANT SELECT ON TABLE public.users TO "Readers";


--
-- PostgreSQL database dump complete
--

\unrestrict 5rKTrZkbntq7JQmqjYkTTrEBKL3RFjudOnX52ytN0kr9J9aVUr4cI5jmrty1Wg7

